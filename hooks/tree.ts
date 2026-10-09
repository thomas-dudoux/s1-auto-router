// Routing Config shape and the Decision Tree evaluator (value / if / switch nodes; `score` lands with Effort).

export type Option = { id: string; description: string }
export type Question = { type: 'choice' | 'yesno' | 'score'; text: string; options?: Option[] }
export type Node = string | { if: string; then: Node; else: Node } | { switch: string; cases: Record<string, Node>; default: Node }
export type RoutingConfig = {
  threshold: number
  prompt_max_chars: number
  questions: Record<string, Question>
  trees: { model?: Node; effort?: Node }
}
export type Answer = { probs: Record<string, number>; confidence: number }
export type Answers = Record<string, Answer>

/** Every question id a tree can consult, in first-seen order. */
export function questionsOf(node: Node, seen: string[] = []): string[] {
  if (typeof node === 'string') return seen
  const id = 'if' in node ? node.if : node.switch
  if (!seen.includes(id)) seen.push(id)
  const children = 'if' in node ? [node.then, node.else] : [...Object.values(node.cases), node.default]
  for (const child of children) questionsOf(child, seen)
  return seen
}

const top = (a: Answer) => Object.entries(a.probs).reduce((best, cur) => (cur[1] > best[1] ? cur : best))[0]

/** Walks the tree on S1's answers: the output, and the question ids on the path taken (for Abstain). */
export function walk(node: Node, answers: Answers, path: string[] = []): { value: string; path: string[] } {
  if (typeof node === 'string') return { value: node, path }
  if ('if' in node) {
    path.push(node.if)
    return walk(top(answers[node.if]) === 'yes' ? node.then : node.else, answers, path)
  }
  path.push(node.switch)
  return walk(node.cases[top(answers[node.switch])] ?? node.default, answers, path)
}
