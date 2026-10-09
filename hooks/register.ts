import type { Engine, Register } from 'claude-code'
import { definitionOf, definitionPaths, type AgentDefinition } from './agent-definition.ts'
import { DEFAULT_CONFIG } from './default-config.ts'
import { parseConfig } from './config.ts'
import type { RoutingConfig } from './tree.ts'
import { BUDGET_MS, URL, parseResponse, requestBody, socketPath } from './s1-client.ts'
import { buildState } from './state.ts'
import { questionsOf, walk, type Question } from './tree.ts'

// Every function that touches `$` lives in this file: the hooks module validator never follows `$` across an import.

// Agent descriptions as offered to the model (agent.offer), for the state of built-in agents.
const offered = new Map<string, string>()
let setupNoticeShown = false

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 's1-setup', description: 'Prepare S1 and run a smoke request', argumentHint: '[--restart]' })
    return result
  })

  on('command.run', { command: 's1-setup' }, async ($, e) => {
    if (e.args.trim() !== '' && e.args.trim() !== '--restart') return { text: 'Usage: /s1-setup [--restart]', exitCode: 1 }
    const model = await $.env.get('S1_MODEL') ?? '2B'
    if (model !== '2B' && model !== '4B') return { text: 'S1_MODEL must be 2B or 4B', exitCode: 1 }
    const sync = await $.process.run(['uv', 'sync', '--project', $.plugin.root], { timeoutMs: 600_000 })
    if (sync.exitCode !== 0) return { text: `S1 environment setup failed: ${sync.stderr}`, exitCode: sync.exitCode }
    const result = await $.process.run([`${$.plugin.root}/.venv/bin/python`, '-m', 's1.setup', ...(e.args.trim() ? ['--restart'] : [])],
      { cwd: $.plugin.root, env: { S1_MODEL: model }, timeoutMs: 600_000 })
    return { text: result.stdout || result.stderr, exitCode: result.exitCode }
  })

  on('agent.offer', ($, e, next) => {
    offered.set(e.agent, e.description)
    return next(e)
  })

  // Routing seam: tool.call on Agent can set model and effort (agent.spawn cannot set effort). Fails open.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    let patch
    try {
      patch = await route($, e)
    } catch (err) {
      $.ui.log(`s1-auto-router fail-open: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
    }
    return next(patch ? { ...e, ...patch } : e)
  })
}

/** The Routing flow for one Spawn: what to change on the Agent call, or undefined to leave it as written. */
async function route($: Engine, e: any): Promise<{ model?: string; effort?: string } | undefined> {
  const type = e.subagent_type ?? 'general-purpose'
  if (type === 'fork' || (e.model !== undefined && e.effort !== undefined)) return undefined
  const def = await agentDefinition($, type)
  if (!def.found) return undefined

  const config = await routingConfig($)
  const outputs = (['model', 'effort'] as const).filter(output =>
    e[output] === undefined && def.frontmatter[output] === undefined && config.trees[output] !== undefined)
  if (!outputs.length) return undefined
  if (!await daemonReady($)) return undefined
  const ids: string[] = []
  for (const output of outputs) questionsOf(config.trees[output]!, ids)
  const questions = Object.fromEntries(ids.map(id => [id, config.questions[id]]))
  const state = buildState(e, def, offered.get(type), config.prompt_max_chars)
  const { answers } = await askS1($, state, questions)
  const patch: { model?: string; effort?: string } = {}
  for (const output of outputs) patch[output] = walk(config.trees[output]!, answers).value
  $.ui.toast(`S1 → ${patch.model ?? e.model ?? def.frontmatter.model} · ${patch.effort ?? e.effort ?? def.frontmatter.effort}`)
  return patch
}

async function agentDefinition($: Engine, type: string): Promise<AgentDefinition> {
  const home = await $.env.get('HOME')
  const installed = type.includes(':') ? await readOrUndefined($, `${home}/.claude/plugins/installed_plugins.json`) : undefined
  for (const path of definitionPaths(type, await $.session.root(), home, installed)) {
    const text = await readOrUndefined($, path)
    if (text !== undefined) return definitionOf(type, text)
  }
  return definitionOf(type, undefined)
}

async function readOrUndefined($: Engine, path: string): Promise<string | undefined> {
  try { return await $.fs.read(path) as string } catch { return undefined }
}

/** One v1 request to the S1 daemon over its unix socket, within the budget. Throws on any failure. */
async function askS1($: Engine, state: object, questions: Record<string, Question>) {
  const home = await $.env.get('HOME')
  const res = await Promise.race([
    $.http.fetch(URL, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: requestBody(state, questions), socketPath: socketPath(home),
    }),
    $.clock.sleep(BUDGET_MS).then(() => { throw new Error(`S1 timeout over ${BUDGET_MS} ms`) }),
  ])
  return parseResponse(res, questions)
}

async function daemonReady($: Engine): Promise<boolean> {
  const home = await $.env.get('HOME')
  const cache = `${home}/.cache/s1-auto-router`
  if (!await $.fs.exists(`${cache}/ready.json`) || !await $.fs.exists(`${$.plugin.root}/.venv/bin/python`)) {
    if (!setupNoticeShown) {
      setupNoticeShown = true
      $.ui.toast('S1 not set up, run /s1-setup')
    }
    return false
  }
  if (!await $.fs.exists(socketPath(home))) {
    const result = await $.process.run([`${$.plugin.root}/.venv/bin/python`, '-m', 's1.setup', 'start'],
      { cwd: $.plugin.root, timeoutMs: 1000 })
    $.ui.log(`s1-auto-router cold start: ${result.exitCode === 0 ? 'starting S1' : result.stderr}`, { to: 'debug' })
    return false
  }
  return true
}

/** First config found wins whole; never merge trees or questions across lookup levels. */
async function routingConfig($: Engine): Promise<RoutingConfig> {
  try {
    const explicit = await $.env.get('S1_ROUTER_CONFIG')
    if (explicit) {
      const text = await readOrUndefined($, explicit)
      if (text === undefined) throw new Error(`Cannot read ${explicit}`)
      return parseConfig(text)
    }
    const home = await $.env.get('HOME')
    for (const directory of [await $.session.root(), home]) {
      const found: { path: string; text: string }[] = []
      for (const extension of ['yaml', 'yml', 'json']) {
        const path = `${directory}/.claude/s1-auto-router.${extension}`
        const text = await readOrUndefined($, path)
        if (text !== undefined) found.push({ path, text })
      }
      if (found.length > 1) $.ui.toast(`S1 Routing Config: several formats found; using ${found[0].path}`)
      if (found.length) return parseConfig(found[0].text)
    }
    return DEFAULT_CONFIG
  } catch (err) {
    $.ui.toast(`S1 Routing Config invalid: ${err instanceof Error ? err.message : String(err)}`)
    throw err
  }
}
