import type { Engine, Register } from 'claude-code'
import { definitionOf, definitionPaths, type AgentDefinition } from './agent-definition.ts'
import { DEFAULT_CONFIG } from './default-config.ts'
import { BUDGET_MS, URL, parseResponse, requestBody, socketPath } from './s1-client.ts'
import { buildState } from './state.ts'
import { questionsOf, walk, type Question } from './tree.ts'

// Every function that touches `$` lives in this file: the hooks module validator never follows `$` across an import.

// Agent descriptions as offered to the model (agent.offer), for the state of built-in agents.
const offered = new Map<string, string>()
const parents = new Map<string, { model?: string; effort?: string }>()

export const register: Register = (on) => {
  on('turn.step', async function* ($, e, next) {
    parents.set(e.agentId ?? 'main', { model: e.model, effort: e.effort })
    return yield* next(e)
  })
  on('agent.offer', ($, e, next) => {
    offered.set(e.agent, e.description)
    return next(e)
  })

  // Routing seam: tool.call on Agent can set model and effort (agent.spawn cannot set effort). Fails open.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    let patch
    let expired = false
    try {
      patch = await Promise.race([
        route($, e, () => expired),
        $.clock.sleep(BUDGET_MS).then(() => { expired = true; throw new Error(`S1 timeout over ${BUDGET_MS} ms`) }),
      ])
    } catch (err) {
      $.ui.log(`s1-auto-router fail-open: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
    }
    return next(patch ? { ...e, ...patch } : e)
  })
}

/** The Routing flow for one Spawn: what to change on the Agent call, or undefined to leave it as written. */
async function route($: Engine, e: any, expired: () => boolean): Promise<{ model?: string; effort?: string } | undefined> {
  const type = e.subagent_type ?? 'general-purpose'
  if (type === 'fork' || (e.model !== undefined && e.effort !== undefined)) return undefined
  const def = await agentDefinition($, type)
  if (!def.found || expired()) return undefined

  const config = DEFAULT_CONFIG
  const outputs = (['model', 'effort'] as const).filter(output =>
    e[output] === undefined && def.frontmatter[output] === undefined && config.trees[output] !== undefined)
  if (!outputs.length) return undefined
  const parent = parents.get(e.agentId ?? 'main') ?? {}
  const parentModel = parent.model ?? (e.agentId === undefined ? await $.session.model() : undefined)
  const ceiling = await $.env.get('S1_ROUTER_CEILING') === 'none' ? 'none' : 'parent'
  const limits = { model: parentModel?.match(/(?:^|-)(haiku|sonnet|opus|fable)(?:-|$)/)?.[1], effort: parent.effort }
  if (expired()) return undefined
  const ids: string[] = []
  for (const output of outputs) questionsOf(config.trees[output]!, ids)
  const questions = Object.fromEntries(ids.map(id => [id, config.questions[id]]))
  const state = buildState(e, def, offered.get(type), config.prompt_max_chars)
  const { answers } = await askS1($, state, questions, expired)
  if (expired()) return undefined
  const patch: { model?: string; effort?: string } = {}
  const display = { model: e.model ?? def.frontmatter.model, effort: e.effort ?? def.frontmatter.effort }
  for (const output of outputs) {
    const { value, path } = walk(config.trees[output]!, answers)
    if (path.some(id => answers[id].confidence < config.threshold)) display[output] = `${output} abstain`
    else {
      const order = output === 'model' ? ['haiku', 'sonnet', 'opus', 'fable'] : ['low', 'medium', 'high', 'xhigh', 'max']
      const limit = limits[output]
      const clamped = ceiling === 'parent' && limit !== undefined && order.indexOf(limit) >= 0 && order.indexOf(value) > order.indexOf(limit)
      patch[output] = clamped ? limit : value
      display[output] = clamped ? `${limit} (clamped from ${value})` : value
    }
  }
  $.ui.toast(`S1 → ${display.model} · ${display.effort}`)
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
