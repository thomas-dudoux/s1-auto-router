import type { Engine, Register } from 'claude-code'
import { definitionOf, definitionPaths, type AgentDefinition } from './agent-definition.ts'
import { DEFAULT_CONFIG } from './default-config.ts'
import { parseConfig } from './config.ts'
import type { RoutingConfig } from './tree.ts'
import { BUDGET_MS, URL, parseResponse, requestBody, socketPath } from './s1-client.ts'
import { buildState } from './state.ts'
import { questionsOf, walk, type Question, type Answers } from './tree.ts'

// Every function that touches `$` lives in this file: the hooks module validator never follows `$` across an import.

// Agent descriptions as offered to the model (agent.offer), for the state of built-in agents.
const offered = new Map<string, string>()
const mismatchWarned = new Set<string>()

type Decision = {
  timestamp: string; state: object; questions: any[]; probabilities: object
  explicit: { model: unknown; effort: unknown }; parent: { model: unknown; effort: unknown }
  ceiling: string; raw: Record<string, string>; applied: Record<string, string>
  reasons: Record<string, string>; latency_ms: number | null
  s1_model: { expected: string; loaded: string; mismatch: boolean } | null
}

export const register: Register = (on) => {
  on('agent.offer', ($, e, next) => {
    offered.set(e.agent, e.description)
    return next(e)
  })

  // Routing seam: tool.call on Agent can set model and effort (agent.spawn cannot set effort). Fails open.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    let patch
    const decision: Decision = {
      timestamp: new Date().toISOString(),
      state: buildState(e, { found: false, frontmatter: {} }, offered.get(e.subagent_type), 4000),
      questions: [], probabilities: {}, explicit: { model: e.model ?? null, effort: e.effort ?? null },
      parent: { model: null, effort: null }, ceiling: 'parent', raw: {}, applied: {}, reasons: {}, latency_ms: null, s1_model: null,
    }
    try {
      decision.timestamp = new Date(await $.clock.now()).toISOString()
      decision.ceiling = await $.env.get('S1_ROUTER_CEILING') === 'none' ? 'none' : 'parent'
      if (await $.env.get('S1_ROUTER') === 'off') decision.reasons.skip = 'disabled'
      else patch = await route($, e, decision)
    } catch (err) {
      decision.reasons.fail_open = err instanceof Error ? err.message : String(err)
      warning($, `s1-auto-router fail-open: ${decision.reasons.fail_open}`)
    }
    decision.applied = patch ?? {}
    await appendDecision($, decision)
    return next(patch ? { ...e, ...patch } : e)
  })
}

/** The Routing flow for one Spawn: what to change on the Agent call, or undefined to leave it as written. */
async function route($: Engine, e: any, decision: Decision): Promise<{ model?: string; effort?: string } | undefined> {
  const type = e.subagent_type ?? 'general-purpose'
  if (type === 'fork' || (e.model !== undefined && e.effort !== undefined)) { decision.reasons.skip = type === 'fork' ? 'fork' : 'explicit'; return undefined }
  const def = await agentDefinition($, type)
  decision.explicit = { model: e.model ?? def.frontmatter.model ?? null, effort: e.effort ?? def.frontmatter.effort ?? null }
  decision.state = buildState(e, def, offered.get(type), 4000)
  if (!def.found) { decision.reasons.skip = 'agent definition unavailable'; return undefined }

  const config = await routingConfig($)
  const outputs = (['model', 'effort'] as const).filter(output =>
    e[output] === undefined && def.frontmatter[output] === undefined && config.trees[output] !== undefined)
  if (!outputs.length) { decision.reasons.skip = 'explicit'; return undefined }
  const ids: string[] = []
  for (const output of outputs) questionsOf(config.trees[output]!, ids)
  const questions = Object.fromEntries(ids.map(id => [id, config.questions[id]]))
  const state = buildState(e, def, offered.get(type), config.prompt_max_chars)
  decision.state = state
  decision.questions = Object.entries(questions).map(([id, q]) => ({ id, ...q }))
  let answers: Answers = {}
  if (ids.length) {
    const started = await $.clock.now()
    let response
    try { response = await askS1($, state, questions) }
    finally { decision.latency_ms = (await $.clock.now()) - started }
    answers = response.answers
    decision.probabilities = answers
    const expected = await $.env.get('S1_MODEL') === '4B' ? 'decider-4b-v11' : 'decider-2b-v11'
    decision.s1_model = { expected, loaded: response.model, mismatch: response.model !== expected }
    if (decision.s1_model.mismatch) {
      const session = await $.session.id()
      if (!mismatchWarned.has(session)) {
        mismatchWarned.add(session)
        toast($, `S1 Decider mismatch: requested ${expected}, using ${response.model}; run /s1-setup --restart to switch`)
      }
    }
  }
  const patch: { model?: string; effort?: string } = {}
  for (const output of outputs) patch[output] = decision.raw[output] = walk(config.trees[output]!, answers).value
  toast($, `S1 → ${patch.model ?? e.model ?? def.frontmatter.model} · ${patch.effort ?? e.effort ?? def.frontmatter.effort}`)
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
      if (found.length > 1) toast($, `S1 Routing Config: several formats found; using ${found[0].path}`)
      if (found.length) return parseConfig(found[0].text)
    }
    return DEFAULT_CONFIG
  } catch (err) {
    toast($, `S1 Routing Config invalid: ${err instanceof Error ? err.message : String(err)}`)
    throw err
  }
}

function warning($: Engine, text: string) {
  try { $.ui.log(text, { to: 'debug' }) } catch {}
}

/** The SDK has no append/chmod; use stdlib Python and stdin so prompts stay out of process arguments. */
async function appendDecision($: Engine, decision: Decision) {
  try {
    const home = await $.env.get('HOME')
    if (!home) throw new Error('HOME is unavailable')
    const result = await $.process.run(['python3', `${$.plugin.root}/s1/append_log.py`, `${home}/.cache/s1-auto-router/decisions.jsonl`], {
      stdin: JSON.stringify(decision) + '\n', timeoutMs: 1000,
    })
    if (result.exitCode !== 0) throw new Error(result.stderr || `exit ${result.exitCode}`)
  } catch (err) {
    warning($, `s1-auto-router decision log failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function toast($: Engine, text: string) {
  try { $.ui.toast(text) } catch (err) { warning($, `s1-auto-router toast failed: ${String(err)}`) }
}
