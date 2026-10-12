// The state S1 sees about a Spawn. Never the Parent's Model or Effort.
import type { AgentDefinition } from './agent-definition.ts'

export function buildState(e: any, def: AgentDefinition, offeredDescription: string | undefined, promptMaxChars: number) {
  const original = String(e.prompt ?? '')
  const { prompt, ...metadata } = routingPrompt(original, promptMaxChars)
  return {
    description: e.description ?? null,
    subagent_type: e.subagent_type ?? 'general-purpose',
    agent_description: def.frontmatter.description ?? offeredDescription ?? null,
    agent_tools: def.frontmatter.tools ?? null,
    isolation: e.isolation ?? null,
    background: e.run_in_background === true,
    ...metadata,
    prompt,
  }
}

function routingPrompt(original: string, limit: number): { prompt: string; work_role?: string; solution_space?: string } {
  const fallback = { prompt: limit > 0 ? original.slice(0, limit) : original }
  // Bound structural parsing even when a custom config disables assignment truncation.
  const leading = /^\s*<metadata>([\s\S]*?)<\/metadata>\s*<prompt>/.exec(original.slice(0, 4000))
  const end = original.trimEnd()
  if (!leading || !end.endsWith('</prompt>')) return fallback
  const fields: Record<string, string | undefined> = {}
  const seen = new Set<string>()
  let offset = 0
  for (const field of leading[1].matchAll(/<([a-z][a-z0-9-]*)>([\s\S]*?)<\/\1>/g)) {
    if (leading[1].slice(offset, field.index).trim()) return fallback
    offset = field.index! + field[0].length
    const name = field[1]
    if (name !== 'work-role' && name !== 'solution-space') continue
    const value = field[2].trim()
    fields[name] = seen.has(name) || !value || /[<>]/.test(value) || (name === 'work-role' && value.length > 256) ? undefined : value
    seen.add(name)
  }
  if (leading[1].slice(offset).trim()) return fallback
  const metadata: { work_role?: string; solution_space?: string } = {}
  let used = 0
  for (const [tag, key] of [['work-role', 'work_role'], ['solution-space', 'solution_space']] as const) {
    const value = fields[tag]
    // Reserve at least half of the existing character budget for the assignment; never truncate a hint into a new meaning.
    if (value && (limit === 0 || used + value.length <= Math.floor(limit / 2))) {
      metadata[key] = value
      used += value.length
    }
  }
  const assignment = end.slice(leading[0].length, -'</prompt>'.length).trim()
  return { ...metadata, prompt: limit > 0 ? assignment.slice(0, limit - used) : assignment }
}
