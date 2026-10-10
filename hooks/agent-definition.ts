// Explicit-value detection, pure half: where an agent definition may live, and its frontmatter.
// tool.call's model/effort override the frontmatter, so the mod must see a frontmatter Explicit value itself.
import { load } from './vendor/js-yaml.mjs'

export type AgentDefinition = { found: boolean; frontmatter: Record<string, unknown> }

/**
 * Candidate files, in order: project agent, then user agent. A plugin agent (`plugin:name`) is located through
 * installed_plugins.json (its text, or undefined when unreadable).
 */
export function definitionPaths(type: string, root: string, home: string | undefined, installedPlugins?: string): string[] {
  if (!type.includes(':')) return [`${root}/.claude/agents/${type}.md`, `${home}/.claude/agents/${type}.md`]
  const [plugin, name] = type.split(':', 2)
  let plugins: Record<string, { installPath: string }[]> = {}
  try { plugins = JSON.parse(installedPlugins ?? '{}').plugins ?? {} } catch {}
  // shortcut: only marketplace-installed plugins are found; a --plugin-dir plugin's agents stay unrouted.
  return Object.entries(plugins)
    .filter(([key]) => key.split('@')[0] === plugin)
    .flatMap(([, installs]) => installs.map(i => `${i.installPath}/agents/${name}.md`))
}

/** A found file's definition; with no file, a built-in (no frontmatter) unless it is a plugin agent (not found). */
export function definitionOf(type: string, text: string | undefined): AgentDefinition {
  if (text === undefined) return { found: !type.includes(':'), frontmatter: {} }
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const data = m ? load(m[1]) : undefined
  return { found: true, frontmatter: data && typeof data === 'object' ? data as Record<string, unknown> : {} }
}
