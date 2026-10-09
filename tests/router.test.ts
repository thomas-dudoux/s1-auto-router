import { test, expect, mock } from 'claude-code/testing'

// Seam A: the real tool.call{Agent} hook, with fake S1 at http.fetch and fake files at fs.read.
const HOME = '/home/u'
const ROOT = '/proj'
const SOCKET = `${HOME}/.cache/s1-auto-router/s1.sock`

type S1 = { answers?: Record<string, Record<string, number>>; text?: string; status?: number; refuse?: boolean; hang?: boolean }

function world(on: any, s1: S1 = {}, files: Record<string, string> = {}, env: Record<string, string> = {}) {
  const w = { logs: [] as string[], toasts: [] as string[], requests: [] as any[], spawned: undefined as any, clock: mock.clock(on) }
  mock.env(on, { HOME, ...env })
  on('session.root', () => ({ value: ROOT }))
  on('fs.read', ($: any, e: any) => (e.path in files ? { value: files[e.path] } : { deny: `ENOENT ${e.path}` }))
  on('ui.log', ($: any, e: any) => { w.logs.push(e.text); return { value: undefined } })
  on('ui.toast', ($: any, e: any) => { w.toasts.push(e.text); return { value: undefined } })
  on('http.fetch', async ($: any, e: any) => {
    w.requests.push({ url: e.url, socketPath: e.init?.socketPath, body: JSON.parse(e.init.body) })
    if (s1.refuse) return { deny: 'ECONNREFUSED' }
    if (s1.hang) await new Promise(() => {})
    const answers = Object.fromEntries(Object.entries(s1.answers ?? {}).map(([id, probs]) =>
      [id, { probs, confidence: Math.max(...Object.values(probs)) }]))
    const text = s1.text ?? JSON.stringify({ version: 1, model: 'decider-2b-v11', answers })
    const status = s1.status ?? 200
    return { value: { status, ok: status < 300, headers: {}, text } }
  })
  on('tool.call', ($: any, e: any) => { w.spawned = e; return { result: 'ok' } })
  return w
}

// Model-only fixtures pin Effort; Effort tests unset it explicitly.
const call = (extra: object = {}) => ({ tool: 'Agent', description: 'list files', prompt: 'List the files in src/', subagent_type: 'Explore', effort: 'high', ...extra }) as any
const yes = { yes: 0.9, no: 0.1 }
const no = { yes: 0.1, no: 0.9 }
const kind = (k: string) => Object.fromEntries(['locate', 'mechanical_edit', 'investigate', 'design', 'synthesize'].map(o => [o, o === k ? 0.8 : 0.05]))

test('a Spawn with neither Explicit value gets Model and Effort in one S1 request', async ($, on) => {
  const w = world(on, { answers: {
    M1: kind('locate'), M2: no, M3: no,
    E1: { clear: 0.8, partly_open: 0.1, very_open: 0.1 }, E2: no, E3: no,
  } })
  await $.tool.call(call({ effort: undefined }))
  expect(w.spawned).toMatchObject({ model: 'haiku', effort: 'low' })
  expect(w.toasts).toEqual(['S1 → haiku · low'])
  expect(w.requests).toHaveLength(1)
  expect(w.requests[0].body.questions.map((q: any) => q.id)).toEqual(['M1', 'M2', 'M3', 'E1', 'E2', 'E3'])
})

const effortCases: [string, Record<string, number>, Record<string, number>, string][] = [
  ['clear instructions', { clear: 1, partly_open: 0, very_open: 0 }, no, 'low'],
  ['partly open instructions', { clear: 0, partly_open: 1, very_open: 0 }, no, 'medium'],
  ['certain open instructions and a long task', { clear: 0, partly_open: 0, very_open: 1 }, yes, 'high'],
  ['uncertain open instructions and a long task', { clear: 0.35, partly_open: 0, very_open: 0.65 }, yes, 'medium'],
]
for (const [name, E1, E2, effort] of effortCases) {
  test(`Effort uses expected weights: ${name} -> ${effort}`, async ($, on) => {
    const w = world(on, { answers: { E1, E2, E3: no } })
    await $.tool.call(call({ model: 'fable', effort: undefined }))
    expect(w.spawned).toMatchObject({ model: 'fable', effort })
    expect(w.requests).toHaveLength(1)
    expect(w.requests[0].body.questions.map((q: any) => q.id)).toEqual(['E1', 'E2', 'E3'])
    expect(w.toasts).toEqual([`S1 → fable · ${effort}`])
  })
}

test('an Explicit Effort stays unchanged while only Model questions are asked', async ($, on) => {
  const w = world(on, { answers: { M1: kind('locate'), M2: no, M3: no } })
  await $.tool.call(call({ effort: 'max' }))
  expect(w.spawned).toMatchObject({ model: 'haiku', effort: 'max' })
  expect(w.requests[0].body.questions.map((q: any) => q.id)).toEqual(['M1', 'M2', 'M3'])
})

test('an Explicit Model in frontmatter allows Effort-only routing', async ($, on) => {
  const w = world(on, { answers: { E1: { clear: 1, partly_open: 0, very_open: 0 }, E2: no, E3: no } },
    { [`${ROOT}/.claude/agents/pinned.md`]: '---\nmodel: inherit\n---\n' })
  await $.tool.call(call({ subagent_type: 'pinned', effort: undefined }))
  expect(w.spawned.model).toBeUndefined()
  expect(w.spawned.effort).toBe('low')
  expect(w.requests[0].body.questions.map((q: any) => q.id)).toEqual(['E1', 'E2', 'E3'])
})

test('an Explicit Effort in frontmatter allows Model-only routing', async ($, on) => {
  const w = world(on, { answers: { M1: kind('locate'), M2: no, M3: no } },
    { [`${ROOT}/.claude/agents/pinned.md`]: '---\neffort: xhigh\n---\n' })
  await $.tool.call(call({ subagent_type: 'pinned', effort: undefined }))
  expect(w.spawned.model).toBe('haiku')
  expect(w.spawned.effort).toBeUndefined()
  expect(w.requests[0].body.questions.map((q: any) => q.id)).toEqual(['M1', 'M2', 'M3'])
})

test('a Spawn without a Model is routed by the default tree, asked over the S1 socket, and toasted', async ($, on) => {
  const w = world(on, { answers: { M1: kind('locate'), M2: no, M3: no } })
  await $.tool.call(call())
  expect(w.spawned.model).toBe('haiku')
  expect(w.toasts).toEqual(['S1 → haiku · high'])
  expect(w.requests).toHaveLength(1)
  expect(w.requests[0].url).toBe('http://s1/v1/answer')
  expect(w.requests[0].socketPath).toBe(SOCKET)
  expect(w.requests[0].body.version).toBe(1)
  expect(w.requests[0].body.questions.map((q: any) => q.id)).toEqual(['M1', 'M2', 'M3'])
})

const branches: [string, object, string][] = [
  ['locate, M2', { M1: kind('locate'), M2: yes, M3: no }, 'sonnet'],
  ['mechanical_edit', { M1: kind('mechanical_edit'), M2: no, M3: no }, 'haiku'],
  ['mechanical_edit, M3', { M1: kind('mechanical_edit'), M2: no, M3: yes }, 'sonnet'],
  ['investigate', { M1: kind('investigate'), M2: no, M3: no }, 'sonnet'],
  ['design, M2', { M1: kind('design'), M2: yes, M3: no }, 'opus'],
  ['synthesize, M3', { M1: kind('synthesize'), M2: no, M3: yes }, 'opus'],
]
for (const [name, answers, model] of branches) {
  test(`default Model tree: ${name} -> ${model}`, async ($, on) => {
    const w = world(on, { answers: answers as any })
    await $.tool.call(call())
    expect(w.spawned.model).toBe(model)
  })
}

test('an Explicit Model in the call is never changed and S1 is not asked', async ($, on) => {
  const w = world(on, { answers: { M1: kind('design'), M2: yes, M3: yes } })
  await $.tool.call(call({ model: 'haiku' }))
  expect(w.spawned.model).toBe('haiku')
  expect(w.requests).toHaveLength(0)
})

test('an Explicit Model in a project agent frontmatter is never changed', async ($, on) => {
  const w = world(on, { answers: { M1: kind('design'), M2: yes, M3: yes } },
    { [`${ROOT}/.claude/agents/pinned.md`]: '---\nname: pinned\nmodel: haiku\n---\nbody' })
  await $.tool.call(call({ subagent_type: 'pinned' }))
  expect(w.spawned.model).toBeUndefined()
  expect(w.requests).toHaveLength(0)
})

test('an Explicit Model in a user agent frontmatter is never changed', async ($, on) => {
  const w = world(on, { answers: { M1: kind('design'), M2: yes, M3: yes } },
    { [`${HOME}/.claude/agents/pinned.md`]: '---\nmodel: inherit\n---\n' })
  await $.tool.call(call({ subagent_type: 'pinned' }))
  expect(w.spawned.model).toBeUndefined()
  expect(w.requests).toHaveLength(0)
})

test('fork Spawns are untouched', async ($, on) => {
  const w = world(on, { answers: { M1: kind('design'), M2: yes, M3: yes } })
  await $.tool.call(call({ subagent_type: 'fork' }))
  expect(w.spawned.model).toBeUndefined()
  expect(w.requests).toHaveLength(0)
})

test('a plugin agent whose definition cannot be found is left unrouted', async ($, on) => {
  const w = world(on, { answers: { M1: kind('locate'), M2: no, M3: no } })
  await $.tool.call(call({ subagent_type: 'someplugin:helper' }))
  expect(w.spawned.model).toBeUndefined()
  expect(w.requests).toHaveLength(0)
})

test('a plugin agent located through installed_plugins.json is routed when its frontmatter sets no Model', async ($, on) => {
  const installed = JSON.stringify({ version: 2, plugins: { 'someplugin@market': [{ installPath: '/cache/someplugin/1.0' }] } })
  const w = world(on, { answers: { M1: kind('locate'), M2: no, M3: no } }, {
    [`${HOME}/.claude/plugins/installed_plugins.json`]: installed,
    '/cache/someplugin/1.0/agents/helper.md': '---\ndescription: helps\n---\n',
  })
  await $.tool.call(call({ subagent_type: 'someplugin:helper' }))
  expect(w.spawned.model).toBe('haiku')
  expect(w.requests[0].body.state.agent_description).toBe('helps')
})

test('the state holds the Spawn and its agent definition, the prompt cut to 4000 chars, and not the Parent', async ($, on) => {
  const w = world(on, { answers: { M1: kind('locate'), M2: no, M3: no } },
    { [`${ROOT}/.claude/agents/scout.md`]: '---\ndescription: Finds things\ntools: Read, Grep\n---\nbody' })
  await $.tool.call(call({ subagent_type: 'scout', prompt: 'x'.repeat(5000), isolation: 'worktree', run_in_background: true }))
  expect(w.requests[0].body.state).toEqual({
    description: 'list files', subagent_type: 'scout', agent_description: 'Finds things', agent_tools: 'Read, Grep',
    isolation: 'worktree', background: true, prompt: 'x'.repeat(4000),
  })
})

test('a built-in agent gets the description it was offered with', async ($, on) => {
  const w = world(on, { answers: { M1: kind('locate'), M2: no, M3: no } })
  on('agent.offer', () => ({ isOffered: true }))
  await $.agent.offer({ agent: 'Explore', description: 'Read-only search agent', source: 'built-in', provider: { plugin: 'engine', tier: 'core' } } as any)
  await $.tool.call(call())
  expect(w.requests[0].body.state).toMatchObject({ subagent_type: 'Explore', agent_description: 'Read-only search agent', agent_tools: null, isolation: null, background: false })
})

const failures: [string, S1][] = [
  ['a refused socket', { refuse: true }],
  ['a body that is not JSON', { text: '<html>oops' }],
  ['an error response', { status: 400, text: '{"version": 1, "error": "bad request"}' }],
  ['a missing answer', { answers: { M1: kind('locate'), M2: no } }],
  ['probabilities that are not numbers', { text: JSON.stringify({ version: 1, model: 'm', answers: { M1: { probs: { locate: 'high' } }, M2: { probs: no }, M3: { probs: no } } }) }],
]
for (const [name, s1] of failures) {
  test(`fails open on ${name}: the Spawn proceeds unchanged`, async ($, on) => {
    const w = world(on, s1)
    await $.tool.call(call())
    expect(w.spawned).toMatchObject(call()); expect(w.spawned.model).toBeUndefined()
    expect(w.toasts).toEqual([])
    expect(w.logs.some(l => l.startsWith('s1-auto-router fail-open'))).toBe(true)
  })
}

test('fails open when S1 takes over 5 s', async ($, on) => {
  const w = world(on, { hang: true })
  const p = $.tool.call(call())
  await w.clock.advance(4999)
  expect(w.spawned).toBeUndefined()
  await w.clock.advance(2)
  await p
  expect(w.spawned).toMatchObject(call()); expect(w.spawned.model).toBeUndefined()
  expect(w.logs.some(l => l.includes('timeout'))).toBe(true)
})
