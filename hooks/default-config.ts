// The bundled default Routing Config, as data in the spec's shape (used when no config file is found).
import type { RoutingConfig } from './tree.ts'

const stronger = (model: string, otherwise: string) => ({ if: 'M2', then: model, else: { if: 'M3', then: model, else: otherwise } })

export const DEFAULT_CONFIG: RoutingConfig = {
  threshold: 0.6,
  prompt_max_chars: 4000,
  questions: {
    M1: {
      type: 'choice', text: 'What kind of work does this subagent task ask for?', options: [
        { id: 'locate', description: 'find where something is: files, symbols, config, docs' },
        { id: 'mechanical_edit', description: 'a mechanical, well-specified code change' },
        { id: 'investigate', description: 'investigate a bug or behaviour and explain the cause' },
        { id: 'design', description: 'design or implement a new feature, module or architecture' },
        { id: 'synthesize', description: 'summarise or synthesise information into a report' },
      ],
    },
    M2: { type: 'yesno', text: 'Does completing this task require understanding interactions across multiple files, components, or systems?' },
    M3: { type: 'yesno', text: 'Would a subtle mistake in the result be costly?' },
    E1: {
      type: 'score', text: 'How much must the agent decide or discover about the approach, even when the desired result is clearly stated?', options: [
        { id: 'clear', description: 'clear, fully specified instructions with little to decide' },
        { id: 'partly_open', description: 'partly open instructions requiring some judgment' },
        { id: 'very_open', description: 'very open instructions requiring substantial exploration or design' },
      ],
    },
    E2: { type: 'yesno', text: 'Is this a long multi-step task?' },
    E3: { type: 'yesno', text: 'Does the task explicitly require testing, validation, measurements, or exact analysis beyond a simple lookup, typo fix, or short summary?' },
  },
  trees: {
    model: {
      switch: 'M1',
      cases: {
        locate: { if: 'M2', then: 'sonnet', else: 'haiku' },
        mechanical_edit: stronger('sonnet', 'haiku'),
        investigate: stronger('opus', 'sonnet'),
        design: stronger('opus', 'sonnet'),
        synthesize: stronger('opus', 'sonnet'),
      },
      default: 'sonnet',
    },
    effort: {
      score: [
        { q: 'E1', weights: { clear: 0, partly_open: 1, very_open: 2 } },
        { q: 'E2', weight: 1 },
        { q: 'E3', weight: 1 },
      ],
      thresholds: { low: 0, medium: 1, high: 2.5 },
    },
  },
}
