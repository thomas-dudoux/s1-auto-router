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
const parents = new Map<string, { model?: string; effort?: string }>()

const mismatchWarned = new Set<string>()

type Decision = {
  timestamp: string; state: object; questions: any[]; probabilities: object
  explicit: { model: unknown; effort: unknown }; parent: { model: unknown; effort: unknown }
  ceiling: string; raw: Record<string, string>; applied: Record<string, string>
  reasons: Record<string, string>; latency_ms: number | null
  started_ms?: number
  s1_model: { expected: string; loaded: string; mismatch: boolean } | null
}
let setupNoticeShown = false

export const register: Register = (on) => {
  on('tool.describe', { tool: 'Agent' }, async ($, e, next) => {
    const result = await next(e)
    return { ...result, description: result.description + '\n\nS1 routing: use your Parent context to start the prompt with <metadata><work-role>short work description</work-role><solution-space>decisions still unresolved about the approach, or state that the approach is settled</solution-space></metadata>, then <prompt>the complete assignment</prompt>. Suggested Work Roles: scout, implementer, architect, reviewer, synthesizer; other short descriptions are welcome. Work Role describes the work, not a fixed Model or Effort. Solution Space describes unresolved decisions, not workload or mistake cost; include scope, risk and verification in the assignment. Keep metadata concise. Missing or invalid metadata falls back to inference from the assignment. Routing preserves the original prompt for the subagent.' }
  })
  on('turn.step', async function* ($, e, next) {
    parents.set(e.agentId ?? 'main', { model: e.model, effort: e.effort })
    return yield* next(e)
  })
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 's1-setup', description: 'Prepare S1 and run a smoke request', argumentHint: '[--restart]' })
    try {
      if (await $.env.get('S1_AUTO_START') !== 'off' && await $.env.get('S1_ROUTER') !== 'off') {
        const setup = await setupS1($, false, false)
        if (setup.exitCode !== 0) throw new Error(setup.text || `exit ${setup.exitCode}`)
      }
    } catch (err) {
      const text = `S1 automatic setup failed: ${err instanceof Error ? err.message : String(err)}; run /s1-setup`
      warning($, text)
      toast($, text)
    }
    return result
  })

  on('command.run', { command: 's1-setup' }, async ($, e) => {
    if (e.args.trim() !== '' && e.args.trim() !== '--restart') return { text: 'Usage: /s1-setup [--restart]', exitCode: 1 }
    return setupS1($, true, e.args.trim() === '--restart')
  })


  on('agent.offer', ($, e, next) => {
    offered.set(e.agent, e.description)
    return next(e)
  })

  // Routing seam: tool.call on Agent can set model and effort (agent.spawn cannot set effort). Fails open.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    let patch
    let expired = false
    const decision: Decision = {
      timestamp: new Date().toISOString(),
      state: buildState(e, { found: false, frontmatter: {} }, offered.get(e.subagent_type), 4000),
      questions: [], probabilities: {}, explicit: { model: e.model ?? null, effort: e.effort ?? null },
      parent: { model: parents.get(e.agentId ?? 'main')?.model ?? null, effort: parents.get(e.agentId ?? 'main')?.effort ?? null }, ceiling: 'parent', raw: {}, applied: {}, reasons: {}, latency_ms: null, s1_model: null,
    }
    const deadline = $.clock.sleep(BUDGET_MS).then(() => { expired = true; throw new Error(`S1 timeout over ${BUDGET_MS} ms`) })
    try {
      patch = await Promise.race([
        (async () => {
          decision.timestamp = new Date(await $.clock.now()).toISOString()
          decision.ceiling = await $.env.get('S1_ROUTER_CEILING') === 'none' ? 'none' : 'parent'
          if (expired) return undefined
          const disabled = await $.env.get('S1_ROUTER') === 'off'
          if (expired) return undefined
          if (disabled) { decision.reasons.skip = 'disabled'; return undefined }
          return route($, e, () => expired, decision)
        })(),
        deadline,
      ])
    } catch (err) {
      if (expired && decision.started_ms !== undefined) decision.latency_ms = Math.max(0, BUDGET_MS - (decision.started_ms - Date.parse(decision.timestamp)))
      decision.reasons.fail_open = err instanceof Error ? err.message : String(err)
      warning($, `s1-auto-router fail-open: ${decision.reasons.fail_open}`)
    }
    decision.applied = patch ?? {}
    if (!expired) await appendDecision($, decision, deadline)
    return next(patch ? { ...e, ...patch } : e)
  })
}

async function setupS1($: Engine, refresh: boolean, restart: boolean) {
  const model = await $.env.get('S1_MODEL') ?? '2B'
  if (model !== '2B' && model !== '4B') return { text: 'S1_MODEL must be 2B or 4B', exitCode: 1 }
  const python = `${$.plugin.root}/.venv/bin/python`
  if (refresh || !await $.fs.exists(python)) {
    const sync = await $.process.run(['uv', 'sync', '--project', $.plugin.root], { timeoutMs: 600_000 })
    if (sync.exitCode !== 0) return { text: `S1 environment setup failed: ${sync.stderr}`, exitCode: sync.exitCode }
  }
  const result = await $.process.run([python, '-m', 's1.setup', ...(restart ? ['--restart'] : [])],
    { cwd: $.plugin.root, env: { S1_MODEL: model }, timeoutMs: 600_000 })
  return { text: result.stdout || result.stderr, exitCode: result.exitCode }
}

/** The Routing flow for one Spawn: what to change on the Agent call, or undefined to leave it as written. */
async function route($: Engine, e: any, expired: () => boolean, decision: Decision): Promise<{ model?: string; effort?: string } | undefined> {
  const type = e.subagent_type ?? 'general-purpose'
  if (type === 'fork' || (e.model !== undefined && e.effort !== undefined)) { decision.reasons.skip = type === 'fork' ? 'fork' : 'explicit'; return undefined }
  const parent = parents.get(e.agentId ?? 'main') ?? {}
  const parentModel = parent.model ?? (e.agentId === undefined ? await $.session.model() : undefined)
  const ceiling = await $.env.get('S1_ROUTER_CEILING') === 'none' ? 'none' : 'parent'
  const limits = { model: parentModel?.match(/(?:^|-)(haiku|sonnet|opus|fable)(?:-|$)/)?.[1], effort: parent.effort }
  decision.parent = { model: parentModel ?? null, effort: parent.effort ?? null }
  decision.ceiling = ceiling
  const def = await agentDefinition($, type)
  if (expired()) return undefined
  decision.explicit = { model: e.model ?? def.frontmatter.model ?? null, effort: e.effort ?? def.frontmatter.effort ?? null }
  decision.state = buildState(e, def, offered.get(type), 4000)
  if (!def.found) { decision.reasons.skip = 'agent definition unavailable'; return undefined }

  const config = await routingConfig($, expired)
  if (expired()) return undefined
  const outputs = (['model', 'effort'] as const).filter(output =>
    e[output] === undefined && def.frontmatter[output] === undefined && config.trees[output] !== undefined)
  if (!outputs.length) { decision.reasons.skip = 'explicit'; return undefined }
  const ids: string[] = []
  for (const output of outputs) questionsOf(config.trees[output]!, ids)
  if (!await daemonReady($, expired, decision, ids.length > 0)) return undefined
  const questions = Object.fromEntries(ids.map(id => [id, config.questions[id]]))
  const state = buildState(e, def, offered.get(type), config.prompt_max_chars)
  decision.state = state
  decision.questions = Object.entries(questions).map(([id, q]) => ({ id, ...q }))
  let answers: Answers = {}
  if (ids.length) {
    const started = decision.started_ms = await $.clock.now()
    let response
    try { response = await askS1($, state, questions, expired) }
    finally { decision.latency_ms = (await $.clock.now()) - started }
    if (expired()) return undefined
    answers = response.answers
    decision.probabilities = answers
    const expected = await $.env.get('S1_MODEL') === '4B' ? 'decider-4b-v11' : 'decider-2b-v11'
    decision.s1_model = { expected, loaded: response.model, mismatch: response.model !== expected }
    if (decision.s1_model.mismatch) {
      const session = await $.session.id()
      if (!expired() && !mismatchWarned.has(session)) {
        mismatchWarned.add(session)
        toast($, `S1 Decider mismatch: requested ${expected}, using ${response.model}; run /s1-setup --restart to switch`)
      }
    }
  }
  if (expired()) return undefined
  const patch: { model?: string; effort?: string } = {}
  const display = { model: e.model ?? def.frontmatter.model, effort: e.effort ?? def.frontmatter.effort }
  for (const output of outputs) {
    const { value, path } = walk(config.trees[output]!, answers)
    decision.raw[output] = value
    if (path.some(id => answers[id].confidence < config.threshold)) { display[output] = `${output} abstain`; decision.reasons[output] = 'abstain' }
    else {
      const order = output === 'model' ? ['haiku', 'sonnet', 'opus', 'fable'] : ['low', 'medium', 'high', 'xhigh', 'max']
      const limit = limits[output]
      const clamped = ceiling === 'parent' && limit !== undefined && order.indexOf(limit) >= 0 && order.indexOf(value) > order.indexOf(limit)
      patch[output] = clamped ? limit : value
      if (clamped) decision.reasons[output] = 'clamp'
      display[output] = clamped ? `${limit} (clamped from ${value})` : value
    }
  }
  toast($, `S1 → ${display.model} · ${display.effort}`)
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
  if (!await $.fs.exists(path)) return undefined
  return await $.fs.read(path) as string
}

/** One v1 request over the S1 socket; the tool.call hook budgets the entire Routing flow. */
async function askS1($: Engine, state: object, questions: Record<string, Question>, expired: () => boolean) {
  const home = await $.env.get('HOME')
  if (expired()) throw new Error(`S1 timeout over ${BUDGET_MS} ms`)
  const res = await $.http.fetch(URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: requestBody(state, questions), socketPath: socketPath(home),
  })
  return parseResponse(res, questions)
}

async function daemonReady($: Engine, expired: () => boolean, decision: Decision, needsInference: boolean): Promise<boolean> {
  const home = await $.env.get('HOME')
  if (expired()) return false
  const cache = `${home}/.cache/s1-auto-router`
  const ready = await $.fs.exists(`${cache}/ready.json`)
  if (expired()) return false
  const python = ready && await $.fs.exists(`${$.plugin.root}/.venv/bin/python`)
  if (expired()) return false
  if (!ready || !python) {
    decision.reasons.skip = 'S1 not set up'
    if (!setupNoticeShown) {
      setupNoticeShown = true
      toast($, 'S1 not set up, run /s1-setup')
    }
    return false
  }
  if (!needsInference) return true
  const socket = await $.fs.exists(socketPath(home))
  if (expired()) return false
  if (!socket) {
    decision.reasons.skip = 'S1 cold start'
    const result = await $.process.run([`${$.plugin.root}/.venv/bin/python`, '-m', 's1.setup', 'start'],
      { cwd: $.plugin.root, timeoutMs: 1000 })
    if (expired()) return false
    $.ui.log(`s1-auto-router cold start: ${result.exitCode === 0 ? 'starting S1' : result.stderr}`, { to: 'debug' })
    return false
  }
  return true
}

/** First config found wins whole; never merge trees or questions across lookup levels. */
async function routingConfig($: Engine, expired: () => boolean): Promise<RoutingConfig> {
  try {
    const explicit = await $.env.get('S1_ROUTER_CONFIG')
    if (explicit) {
      const text = await readOrUndefined($, explicit)
      if (text === undefined) throw new Error(`Cannot read ${explicit}`)
      return parseConfig(text)
    }
    const home = await $.env.get('HOME')
    for (const directory of [await $.session.root(), home]) {
      const found: string[] = []
      for (const extension of ['yaml', 'yml', 'json']) {
        const path = `${directory}/.claude/s1-auto-router.${extension}`
        if (await $.fs.exists(path)) found.push(path)
      }
      if (!expired() && found.length > 1) toast($, `S1 Routing Config: several formats found; using ${found[0]}`)
      if (found.length) return parseConfig(await $.fs.read(found[0]))
    }
    return DEFAULT_CONFIG
  } catch (err) {
    if (!expired()) toast($, `S1 Routing Config invalid: ${err instanceof Error ? err.message : String(err)}`)
    throw err
  }
}

function warning($: Engine, text: string) {
  try { $.ui.log(text, { to: 'debug' }) } catch {}
}

/** The SDK has no append/chmod; use stdlib Python and stdin so prompts stay out of process arguments. */
async function appendDecision($: Engine, decision: Decision, deadline: Promise<never>) {
  let expired = false
  try {
    await Promise.race([
      (async () => {
        const home = await $.env.get('HOME')
        if (expired) return
        if (!home) throw new Error('HOME is unavailable')
        const remaining = Math.min(1000, BUDGET_MS - ((await $.clock.now()) - Date.parse(decision.timestamp)))
        if (expired || remaining <= 0) throw new Error('decision append timed out')
        const { started_ms, ...entry } = decision
        const result = await $.process.run(['python3', '-m', 's1.append_log', `${home}/.cache/s1-auto-router/decisions.jsonl`], {
          cwd: $.plugin.root, stdin: JSON.stringify(entry) + '\n', timeoutMs: remaining, env: { HOME: home },
        })
        if (result.exitCode !== 0) throw new Error(result.stderr || `exit ${result.exitCode}`)
        if (result.stderr) warning($, `s1-auto-router decision log warning: ${result.stderr}`)
      })(),
      $.clock.sleep(1000).then(() => { expired = true; throw new Error('decision append timed out') }),
      deadline,
    ])
  } catch (err) {
    expired = true
    warning($, `s1-auto-router decision log failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function toast($: Engine, text: string) {
  try { $.ui.toast(text) } catch (err) { warning($, `s1-auto-router toast failed: ${String(err)}`) }
}
