// S1 client, pure half: the v1 request and the response validation. The fetch and the 5 s race live in
// register.ts, because `$` cannot cross an import.
import type { HttpResponse } from 'claude-code'
import type { Answers, Question } from './tree.ts'

export const BUDGET_MS = 5000
export const URL = 'http://s1/v1/answer'
export const socketPath = (home: string | undefined) => `${home}/.cache/s1-auto-router/s1.sock`

export function requestBody(state: object, questions: Record<string, Question>): string {
  return JSON.stringify({ version: 1, state, questions: Object.entries(questions).map(([id, q]) => ({ id, ...q })) })
}

/** Validated probabilities and confidence for every question asked, or throws to fail open. */
export function parseResponse(res: HttpResponse, questions: Record<string, Question>): { model: string; answers: Answers } {
  let payload: any
  try { payload = JSON.parse(res.text) } catch { throw new Error(`S1 HTTP ${res.status}: body is not JSON`) }
  if (!res.ok || payload?.error) throw new Error(`S1 HTTP ${res.status}: ${payload?.error ?? 'error'}`)
  if (payload?.version !== 1 || typeof payload.model !== 'string' || !payload.model.trim()
    || typeof payload.answers !== 'object' || !payload.answers || Array.isArray(payload.answers)) throw new Error('S1 answer is malformed')
  for (const [id, q] of Object.entries(questions)) {
    const probs = payload.answers[id]?.probs
    const options = q.type === 'yesno' ? ['yes', 'no'] : (q.options ?? []).map(o => o.id)
    if (!probs || typeof probs !== 'object' || Array.isArray(probs)
      || Object.keys(probs).length !== options.length || !options.every(o => Object.hasOwn(probs, o))) throw new Error(`S1 answer to ${id} is malformed`)
    const values = options.map(o => probs[o])
    const confidence = payload.answers[id].confidence
    if (!values.every(p => Number.isFinite(p) && p >= 0 && p <= 1)
      || Math.abs(values.reduce((sum, p) => sum + p, 0) - 1) > 1e-6
      || !Number.isFinite(confidence) || confidence < 0 || confidence > 1
      || Math.abs(confidence - Math.max(...values)) > 1e-6) throw new Error(`S1 answer to ${id} is malformed`)
  }
  return { model: payload.model, answers: payload.answers }
}
