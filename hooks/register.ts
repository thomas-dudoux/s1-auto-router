import type { Engine, Register } from 'claude-code'
import { definitionOf, definitionPaths, type AgentDefinition } from './agent-definition.ts'
import { DEFAULT_CONFIG } from './default-config.ts'
import { BUDGET_MS, URL, parseResponse, requestBody, socketPath } from './s1-client.ts'
import { buildState } from './state.ts'
import { questionsOf, walk, type Question } from './tree.ts'

// Every function that touches `$` lives in this file: the hooks module validator never follows `$` across an import.

// Agent descriptions as offered to the model (agent.offer), for the state of built-in agents.
const offered = new Map<string, string>()

export const register: Register = (on) => {
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
async function route($: Engine, e: any): Promise<{ model?: string } | undefined> {
  const type = e.subagent_type ?? 'general-purpose'
  if (type === 'fork' || e.model !== undefined) return undefined
  const def = await agentDefinition($, type)
  if (!def.found || def.frontmatter.model !== undefined) return undefined

  const config = DEFAULT_CONFIG
  const tree = config.trees.model!
  const questions = Object.fromEntries(questionsOf(tree).map(id => [id, config.questions[id]]))
  const state = buildState(e, def, offered.get(type), config.prompt_max_chars)
  const { answers } = await askS1($, state, questions)
  const { value: model } = walk(tree, answers)
  $.ui.toast(`S1 → ${model}`)
  return { model }
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
