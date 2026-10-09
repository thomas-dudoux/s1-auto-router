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

/** The answers to every question asked, or throws with the reason (error status, non-JSON, missing probabilities). */
export function parseResponse(res: HttpResponse, questions: Record<string, Question>): { model: string; answers: Answers } {
  let payload: any
  try { payload = JSON.parse(res.text) } catch { throw new Error(`S1 HTTP ${res.status}: body is not JSON`) }
  if (!res.ok || payload?.error) throw new Error(`S1 HTTP ${res.status}: ${payload?.error ?? 'error'}`)
  if (payload?.version !== 1 || typeof payload.answers !== 'object' || !payload.answers) throw new Error('S1 answer is malformed')
  for (const [id, q] of Object.entries(questions)) {
    const probs = payload.answers[id]?.probs
    const options = q.type === 'yesno' ? ['yes', 'no'] : (q.options ?? []).map(o => o.id)
    if (!options.every(o => Number.isFinite(probs?.[o]))) throw new Error(`S1 answer to ${id} is malformed`)
  }
  return { model: String(payload.model), answers: payload.answers }
}
