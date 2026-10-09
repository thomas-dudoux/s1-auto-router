import { load } from './vendor/js-yaml.mjs'
import type { RoutingConfig } from './tree.ts'

const object = (value: any): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: any) => typeof value === 'string' && value.trim().length > 0
const fail = (reason: string): never => { throw new Error(reason) }

/** Parse YAML (including JSON) and reject the whole config before S1 sees any question. */
export function parseConfig(source: string): RoutingConfig {
  const config: any = load(source)
  if (!object(config) || !object(config.questions) || !object(config.trees)) fail('Expected questions and trees maps')
  if (config.threshold === undefined) config.threshold = 0.6
  if (config.prompt_max_chars === undefined) config.prompt_max_chars = 4000
  if (!Number.isFinite(config.threshold) || config.threshold < 0 || config.threshold > 1) fail('threshold must be between 0 and 1')
  if (!Number.isSafeInteger(config.prompt_max_chars) || config.prompt_max_chars < 0) fail('prompt_max_chars must be a nonnegative integer')
  for (const [id, q] of Object.entries(config.questions) as [string, any][]) {
    if (!text(id) || !object(q) || !['choice', 'yesno', 'score'].includes(q.type) || !text(q.text)) fail(`Invalid question ${id}`)
    if (q.type === 'yesno') {
      if (q.options !== undefined) fail(`yesno question ${id} cannot define options`)
    } else {
      if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 10) fail(`Question ${id} needs 2 to 10 options`)
      const ids = new Set<string>()
      for (const option of q.options) {
        if (!object(option) || !text(option.id) || !text(option.description) || ids.has(option.id)) fail(`Invalid option in ${id}`)
        ids.add(option.id)
      }
    }
  }
  const question = (id: any, types: string[]) => {
    if (typeof id !== 'string' || !Object.hasOwn(config.questions, id)) fail(`Unknown question ${String(id)}`)
    const q = config.questions[id]
    if (!types.includes(q.type)) fail(`Wrong question type for ${id}`)
    return q
  }
  const options = (id: string, entries: any) => {
    const q = question(id, ['choice', 'score'])
    if (!object(entries)) fail(`Expected option map for ${id}`)
    for (const option of Object.keys(entries)) {
      if (!q.options.some((o: any) => o.id === option)) fail(`Unknown option ${option} for ${id}`)
    }
  }
  for (const [output, values] of [['model', ['haiku', 'sonnet', 'opus']], ['effort', ['low', 'medium', 'high']]] as const) {
    const active = new Set<object>()
    const node = (n: any): void => {
      if (typeof n === 'string') {
        if (!(values as readonly string[]).includes(n)) fail(`Invalid ${output} value ${n}`)
        return
      }
      if (!object(n) || active.has(n)) fail(`Invalid ${output} node`)
      if (['if', 'switch', 'score'].filter(kind => Object.hasOwn(n, kind)).length !== 1) fail(`Ambiguous ${output} node`)
      active.add(n)
      if (Object.hasOwn(n, 'if')) {
        question(n.if, ['yesno'])
        node(n.then); node(n.else)
      } else if (Object.hasOwn(n, 'switch')) {
        options(n.switch, n.cases)
        for (const child of Object.values(n.cases)) node(child)
        if (!Object.hasOwn(n, 'default')) fail(`Missing default in ${output} switch`)
        node(n.default)
      } else if (Object.hasOwn(n, 'score')) {
        if (!Array.isArray(n.score) || n.score.length === 0) fail('score needs at least one term')
        for (const term of n.score) {
          if (!object(term)) fail('Invalid score term')
          const q = question(term.q, ['yesno', 'choice', 'score'])
          if (q.type === 'yesno') {
            if (!Number.isFinite(term.weight) || term.weights !== undefined) fail(`Invalid weight for ${term.q}`)
          } else {
            options(term.q, term.weights)
            if (term.weight !== undefined || !Object.keys(term.weights).length || !Object.values(term.weights).every(Number.isFinite)) fail(`Invalid weights for ${term.q}`)
          }
        }
        if (!object(n.thresholds) || !Object.keys(n.thresholds).length) fail('score needs thresholds')
        for (const [value, threshold] of Object.entries(n.thresholds)) {
          if (!(values as readonly string[]).includes(value) || !Number.isFinite(threshold)) fail(`Invalid ${output} threshold ${value}`)
        }
      } else fail(`Unknown ${output} node kind`)
      active.delete(n)
    }
    node(config.trees[output])
  }
  return config as RoutingConfig
}
