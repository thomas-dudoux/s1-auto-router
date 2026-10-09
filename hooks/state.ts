// The state S1 sees about a Spawn. Never the Parent's Model or Effort.
import type { AgentDefinition } from './agent-definition.ts'

export function buildState(e: any, def: AgentDefinition, offeredDescription: string | undefined, promptMaxChars: number) {
  const prompt = String(e.prompt ?? '')
  return {
    description: e.description ?? null,
    subagent_type: e.subagent_type ?? 'general-purpose',
    agent_description: def.frontmatter.description ?? offeredDescription ?? null,
    agent_tools: def.frontmatter.tools ?? null,
    isolation: e.isolation ?? null,
    background: e.run_in_background === true,
    prompt: promptMaxChars > 0 ? prompt.slice(0, promptMaxChars) : prompt,
  }
}
