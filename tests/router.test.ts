import { test, expect, mock } from 'claude-code/testing'

// Seam A: the real tool.call{Agent} hook, with fake S1 at http.fetch and fake files at fs.read.
const HOME = '/home/u'
const ROOT = '/proj'
const SOCKET = `${HOME}/.cache/s1-auto-router/s1.sock`

type S1 = { model?: string; logFailure?: boolean; toastFailure?: boolean; answers?: Record<string, Record<string, number>>; text?: string; status?: number; refuse?: boolean; hang?: boolean; notReady?: boolean; noSocket?: boolean }

function world(on: any, s1: S1 = {}, files: Record<string, string> = {}, env: Record<string, string> = {}) {
  const w = { logs: [] as string[], toasts: [] as string[], requests: [] as any[], spawned: undefined as any, clock: mock.clock(on), processes: [] as any[], session: 'session-test' }
  mock.env(on, { HOME, ...env })
  on('session.root', () => ({ value: ROOT }))
  on('session.id', () => ({ value: w.session }))
  on('process.run', ($: any, e: any) => { w.processes.push(e); if (s1.logFailure) return { deny: 'disk full' }; return { value: { exitCode: 0, stdout: '', stderr: '' } } })
  on('fs.exists', ($: any, e: any) => ({ value: e.path.endsWith('ready.json') ? !s1.notReady : e.path.endsWith('s1.sock') ? !s1.noSocket : true }))

  on('fs.read', ($: any, e: any) => (e.path in files ? { value: files[e.path] } : { deny: `ENOENT ${e.path}` }))
  on('ui.log', ($: any, e: any) => { w.logs.push(e.text); return { value: undefined } })
  on('ui.toast', ($: any, e: any) => { w.toasts.push(e.text); if (s1.toastFailure) return { deny: 'toast unavailable' }; return { value: undefined } })
  on('http.fetch', async ($: any, e: any) => {
    w.requests.push({ url: e.url, socketPath: e.init?.socketPath, body: JSON.parse(e.init.body) })
    if (s1.refuse) return { deny: 'ECONNREFUSED' }
    if (s1.hang) await new Promise(() => {})
    const answers = Object.fromEntries(Object.entries(s1.answers ?? {}).map(([id, probs]) =>
      [id, { probs, confidence: Math.max(...Object.values(probs)) }]))
    const text = s1.text ?? JSON.stringify({ version: 1, model: s1.model ?? 'decider-2b-v11', answers })
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


test('before setup every Spawn fails open and the setup notice appears once', async ($, on) => {
  const w = world(on, { notReady: true })
  await $.tool.call(call())
  await $.tool.call(call())
  expect(w.spawned.model).toBeUndefined()
  expect(w.requests).toHaveLength(0)
  expect(w.processes.filter(p => p.argv.includes('s1.setup'))).toHaveLength(0)
  expect(w.toasts).toEqual(['S1 not set up, run /s1-setup'])
})


test('a Spawn with no socket starts S1 and fails open, then later Spawns route', async ($, on) => {
  const s1 = { noSocket: true, answers: { M1: kind('locate'), M2: no, M3: no } }
  const w = world(on, s1)
  await $.tool.call(call())
  expect(w.spawned.model).toBeUndefined()
  expect(w.requests).toHaveLength(0)
  expect(w.processes.filter(p => p.argv.includes('s1.setup'))).toHaveLength(1)
  expect(w.processes[0].argv.slice(1)).toEqual(['-m', 's1.setup', 'start'])
  s1.noSocket = false
  await $.tool.call(call())
  expect(w.spawned.model).toBe('haiku')
})

const customConfig = (model: unknown = 'sonnet', effort: unknown = 'medium', extra: object = {}) => JSON.stringify({
  questions: {}, trees: { model, effort }, ...extra,
})

test('the env Routing Config wins whole over project and user files', async ($, on) => {
  const w = world(on, {}, {
    '/shared/routing.json': customConfig('opus'),
    [`${ROOT}/.claude/s1-auto-router.yaml`]: customConfig('haiku'),
    [`${HOME}/.claude/s1-auto-router.json`]: customConfig('sonnet'),
  }, { S1_ROUTER_CONFIG: '/shared/routing.json' })
  await $.tool.call(call({ effort: undefined }))
  expect(w.spawned.model).toBe('opus')
  expect(w.requests).toHaveLength(0)
})

test('an invalid Routing Config toasts and fails open before asking S1', async ($, on) => {
  const w = world(on, {}, { [`${ROOT}/.claude/s1-auto-router.json`]: customConfig({ switch: 'missing', cases: {} }) })
  await $.tool.call(call({ effort: undefined }))
  expect(w.spawned).toMatchObject(call({ effort: undefined }))
  expect(w.spawned.model).toBeUndefined()
  expect(w.spawned.effort).toBeUndefined()
  expect(w.requests).toHaveLength(0)
  expect(w.toasts.some(t => t.startsWith('S1 Routing Config invalid:'))).toBe(true)
})

test('a custom probability-weighted score tree is accepted alongside a value Model tree', async ($, on) => {
  const w = world(on, { answers: { open: { clear: 0.2, broad: 0.8 }, exact: yes } }, {
    [`${ROOT}/.claude/s1-auto-router.json`]: customConfig('sonnet', {
      score: [{ q: 'open', weights: { clear: 0, broad: 2 } }, { q: 'exact', weight: 1 }],
      thresholds: { low: 0, medium: 1, high: 2.5 },
    }, { questions: {
      open: { type: 'score', text: 'How open is this task?', options: [{ id: 'clear', description: 'fully specified' }, { id: 'broad', description: 'open design' }] },
      exact: { type: 'yesno', text: 'Must the result be exact?' },
    } }),
  })
  await $.tool.call(call({ effort: undefined }))
  expect(w.spawned.model).toBe('sonnet')
  expect(w.spawned.effort).toBe('high')
})

const yamlCustom = `# A user question can drive either Decision Tree.
questions:
  costly:
    type: yesno
    text: Would a mistake be costly?
trees:
  model:
    if: costly
    then: opus
    else: haiku
  effort: medium
`

for (const [name, files, model] of [
  ['project precedes user', { [`${ROOT}/.claude/s1-auto-router.json`]: customConfig('haiku'), [`${HOME}/.claude/s1-auto-router.yaml`]: customConfig('opus') }, 'haiku'],
  ['user precedes bundled', { [`${HOME}/.claude/s1-auto-router.json`]: customConfig('sonnet') }, 'sonnet'],
  ['YAML custom yes/no', { [`${ROOT}/.claude/s1-auto-router.yaml`]: yamlCustom }, 'opus'],
  ['yml is supported', { [`${ROOT}/.claude/s1-auto-router.yml`]: yamlCustom }, 'opus'],
] as [string, Record<string, string>, string][]) {
  test(`Routing Config lookup: ${name}`, async ($, on) => {
    const w = world(on, { answers: { costly: yes } }, files)
    await $.tool.call(call({ effort: undefined }))
    expect(w.spawned.model).toBe(model)
  })
}

test('duplicate formats warn and yaml wins over yml and json at the same level', async ($, on) => {
  const w = world(on, { answers: { costly: yes } }, {
    [`${ROOT}/.claude/s1-auto-router.yaml`]: yamlCustom,
    [`${ROOT}/.claude/s1-auto-router.yml`]: customConfig('haiku'),
    [`${ROOT}/.claude/s1-auto-router.json`]: customConfig('sonnet'),
  })
  await $.tool.call(call({ effort: undefined }))
  expect(w.spawned.model).toBe('opus')
  expect(w.toasts.some(t => t.includes('several formats') && t.includes('s1-auto-router.yaml'))).toBe(true)
})

const choiceQuestion = { type: 'choice', text: 'Which work?', options: [{ id: 'small', description: 'small work' }, { id: 'large', description: 'large work' }] }
const configErrors: [string, string][] = [
  ['unknown question', customConfig({ if: 'missing', then: 'haiku', else: 'sonnet' })],
  ['wrong if question type', customConfig({ if: 'work', then: 'haiku', else: 'sonnet' }, 'medium', { questions: { work: choiceQuestion } })],
  ['wrong switch question type', customConfig({ switch: 'work', cases: {}, default: 'sonnet' }, 'medium', { questions: { work: { type: 'yesno', text: 'Is it work?' } } })],
  ['unknown option', customConfig({ switch: 'work', cases: { missing: 'haiku' }, default: 'sonnet' }, 'medium', { questions: { work: choiceQuestion } })],
  ['invalid Model value', customConfig('fable')],
  ['invalid Effort value', customConfig('sonnet', 'max')],
  ['invalid threshold key', customConfig('sonnet', { score: [{ q: 'work', weights: { small: 0, large: 1 } }], thresholds: { max: 0 } }, { questions: { work: choiceQuestion } })],
  ['missing default', customConfig({ switch: 'work', cases: { small: 'haiku' } }, 'medium', { questions: { work: choiceQuestion } })],
  ['missing effort tree', JSON.stringify({ questions: {}, trees: { model: 'haiku' } })],
  ['malformed YAML', 'trees: ['],
  ['ambiguous node', customConfig({ if: 'costly', then: 'haiku', else: 'sonnet', switch: 'work', cases: {}, default: 'sonnet' }, 'medium', { questions: { costly: { type: 'yesno', text: 'Costly?' }, work: choiceQuestion } })],
  ['too many options', customConfig('sonnet', 'medium', { questions: { work: { ...choiceQuestion, options: Array.from({ length: 11 }, (_, i) => ({ id: `o${i}`, description: `option ${i}` })) } } })],
  ['null confidence threshold', customConfig('sonnet', 'medium', { threshold: null })],
  ['invalid confidence threshold', customConfig('sonnet', 'medium', { threshold: 2 })],
  ['negative prompt limit', customConfig('sonnet', 'medium', { prompt_max_chars: -1 })],
  ['invalid score weight', customConfig('sonnet', { score: [{ q: 'work', weights: { small: 'high' } }], thresholds: { low: 0 } }, { questions: { work: choiceQuestion } })],
  ['unknown score option', customConfig('sonnet', { score: [{ q: 'work', weights: { missing: 1 } }], thresholds: { low: 0 } }, { questions: { work: choiceQuestion } })],
  ['unknown score question', customConfig('sonnet', { score: [{ q: 'missing', weight: 1 }], thresholds: { low: 0 } })],
  ['missing option description', customConfig('sonnet', 'medium', { questions: { work: { ...choiceQuestion, options: [{ id: 'small' }, { id: 'large', description: 'large' }] } } })],
]
for (const [name, config] of configErrors) {
  test(`invalid Routing Config: ${name} toasts and leaves the Spawn unchanged`, async ($, on) => {
    const w = world(on, {}, { [`${ROOT}/.claude/s1-auto-router.json`]: config, [`${HOME}/.claude/s1-auto-router.yaml`]: customConfig('opus') })
    await $.tool.call(call({ effort: undefined }))
    expect(w.spawned).toMatchObject(call({ effort: undefined }))
    expect(w.spawned.model).toBeUndefined(); expect(w.spawned.effort).toBeUndefined()
    expect(w.requests).toHaveLength(0)
    expect(w.toasts.some(t => t.startsWith('S1 Routing Config invalid:'))).toBe(true)
  })
}

for (const [limit, expected] of [[3, 'abc'], [0, 'abcdefgh']] as const) {
  test(`prompt_max_chars ${limit} is respected in the state sent to S1`, async ($, on) => {
    const w = world(on, { answers: { costly: yes } }, { [`${ROOT}/.claude/s1-auto-router.json`]: customConfig({ if: 'costly', then: 'sonnet', else: 'haiku' }, 'medium', { prompt_max_chars: limit, questions: { costly: { type: 'yesno', text: 'Costly?' } } }) })
    await $.tool.call(call({ effort: undefined, prompt: 'abcdefgh' }))
    expect(w.spawned.model).toBe('sonnet')
    expect(w.requests[0].body.state.prompt).toBe(expected)
  })
}

test('a missing env config fails open without using a lower-precedence file', async ($, on) => {
  const w = world(on, {}, { [`${ROOT}/.claude/s1-auto-router.json`]: customConfig('opus') }, { S1_ROUTER_CONFIG: '/missing.yaml' })
  await $.tool.call(call({ effort: undefined }))
  expect(w.spawned.model).toBeUndefined(); expect(w.spawned.effort).toBeUndefined()
  expect(w.toasts.some(t => t.startsWith('S1 Routing Config invalid:'))).toBe(true)
  expect(w.requests).toHaveLength(0)
})

test('S1_ROUTER=off leaves the Spawn unchanged without asking S1 or showing a toast', async ($, on) => {
  const w = world(on, { answers: { M1: kind('design'), M2: yes, M3: yes } }, {}, { S1_ROUTER: 'off' })
  await $.tool.call(call())
  expect(w.spawned).toMatchObject(call()); expect(w.spawned.model).toBeUndefined()
  expect(w.requests).toHaveLength(0)
  expect(w.toasts).toEqual([])
})


test('each routed Spawn appends a JSONL decision with the full Routing context', async ($, on) => {
  const w = world(on, { answers: { M1: kind('locate'), M2: no, M3: no } })
  await $.tool.call(call())
  const writes = w.processes.filter(p => p.argv.some((arg: string) => arg.endsWith('/s1/append_log.py')))
  expect(writes).toHaveLength(1)
  expect(writes[0].argv.at(-1)).toBe(`${HOME}/.cache/s1-auto-router/decisions.jsonl`)
  expect(writes[0].init.stdin.endsWith('\n')).toBe(true)
  const entry = JSON.parse(writes[0].init.stdin)
  expect(entry).toMatchObject({
    state: { description: 'list files', prompt: 'List the files in src/', subagent_type: 'Explore' },
    explicit: { model: null, effort: 'high' }, parent: { model: null, effort: null }, ceiling: 'parent',
    probabilities: { M1: { probs: kind('locate') } }, raw: { model: 'haiku' }, applied: { model: 'haiku' },
    reasons: {}, latency_ms: 0,
  })
  expect(typeof entry.timestamp).toBe('string')
  expect(entry.questions.map((q: any) => q.id)).toEqual(['M1', 'M2', 'M3'])
})


test('a different loaded Decider is used, toasted once per session and recorded in every decision', async ($, on) => {
  const w = world(on, { model: 'decider-4b-v11', answers: { M1: kind('locate'), M2: no, M3: no } })
  await $.tool.call(call())
  await $.tool.call(call())
  expect(w.spawned.model).toBe('haiku')
  expect(w.toasts.filter(t => t.includes('Decider mismatch'))).toHaveLength(1)
  const entries = w.processes.map(p => JSON.parse(p.init.stdin))
  expect(entries).toHaveLength(2)
  for (const entry of entries) expect(entry.s1_model).toEqual({ expected: 'decider-2b-v11', loaded: 'decider-4b-v11', mismatch: true })
})


for (const [name, s1, extra] of [
  ['S1 refusal', { refuse: true }, {}],
  ['fork', {}, { subagent_type: 'fork' }],
  ['both Explicit values', {}, { model: 'opus', effort: 'max' }],
] as [string, S1, object][]) {
  test(`a decision line records ${name} even when no value is applied`, async ($, on) => {
    const w = world(on, s1)
    await $.tool.call(call(extra))
    expect(w.processes).toHaveLength(1)
    const entry = JSON.parse(w.processes[0].init.stdin)
    expect(entry.state.prompt).toBe('List the files in src/')
    expect(entry.applied).toEqual({})
    expect(Object.keys(entry.reasons).length).toBe(1)
  })
}

for (const failure of ['logFailure', 'toastFailure'] as const) {
  test(`${failure} does not stop the Spawn or discard its Routing result`, async ($, on) => {
    const w = world(on, { [failure]: true, answers: { M1: kind('locate'), M2: no, M3: no } })
    await $.tool.call(call())
    expect(w.spawned.model).toBe('haiku')
    if (failure === 'logFailure') expect(w.logs.some(l => l.includes('decision log failed'))).toBe(true)
  })
}

test('model mismatch warning is independent for each session and matching models do not warn', async ($, on) => {
  const w = world(on, { model: 'decider-4b-v11', answers: { M1: kind('locate'), M2: no, M3: no } })
  await $.tool.call(call())
  w.session = 'another-session'
  await $.tool.call(call())
  expect(w.toasts.filter(t => t.includes('Decider mismatch'))).toHaveLength(2)
})

test('S1_MODEL=4B matches a running 4B Decider without a mismatch warning', async ($, on) => {
  const w = world(on, { model: 'decider-4b-v11', answers: { M1: kind('locate'), M2: no, M3: no } }, {}, { S1_MODEL: '4B' })
  await $.tool.call(call())
  expect(w.toasts.filter(t => t.includes('Decider mismatch'))).toHaveLength(0)
  expect(JSON.parse(w.processes[0].init.stdin).s1_model.mismatch).toBe(false)
})


test('constant Model and Effort trees route without making an empty S1 request', async ($, on) => {
  const w = world(on, { refuse: true }, { [`${ROOT}/.claude/s1-auto-router.json`]: customConfig('sonnet', 'medium') })
  await $.tool.call(call({ effort: undefined }))
  expect(w.spawned).toMatchObject({ model: 'sonnet', effort: 'medium' })
  expect(w.requests).toHaveLength(0)
  const entry = JSON.parse(w.processes[0].init.stdin)
  expect(entry.latency_ms).toBe(null)
  expect(entry.s1_model).toBe(null)
})
