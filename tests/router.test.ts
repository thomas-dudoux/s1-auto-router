import { test, expect, mock } from 'claude-code/testing'
import { SOLUTION_SPACE_CONFIG as candidate } from '../hooks/solution-space-candidate.ts'

// Seam A: the real tool.call{Agent} hook, with fake S1 at http.fetch and fake files at fs.read.
const HOME = '/home/u'
const ROOT = '/proj'
const SOCKET = `${HOME}/.cache/s1-auto-router/s1.sock`

type S1 = { model?: string; logFailure?: boolean; toastFailure?: boolean; answers?: Record<string, Record<string, number>>; text?: string; status?: number; refuse?: boolean; hang?: boolean; responseBlock?: Promise<void>; notReady?: boolean; noSocket?: boolean; noPython?: boolean; daemon?: number }
type ProcessEvent = { argv: string[]; init?: { stdin?: string; timeoutMs?: number } }
type ProcessReply = { value: { exitCode: number; stdout: string; stderr: string } } | { deny: string } | undefined
type WorldSetup = { parentModel?: string; readBlock?: Promise<void>; readErrors?: Record<string, string>; process?: (event: ProcessEvent) => ProcessReply | void; envBlock?: { name: string; wait: Promise<void>; when?: () => boolean } }

function world(on: Parameters<typeof mock.clock>[0], s1: S1 = {}, files: Record<string, string> = {}, env: Record<string, string> = {}, setup: WorldSetup = {}) {
  const w = { logs: [] as string[], toasts: [] as string[], requests: [] as any[], spawned: undefined as any, clock: mock.clock(on), processes: [] as any[], commands: [] as any[], session: 'session-test' }
  on('env.get', async ($: any, e: any) => {
    if (setup.envBlock?.name === e.name && (setup.envBlock.when?.() ?? true)) await setup.envBlock.wait
    return { value: ({ HOME, ...env } as Record<string, string>)[e.name] }
  })
  on('session.root', () => ({ value: ROOT }))
  on('session.id', () => ({ value: w.session }))
  on('session.model', () => ({ value: setup.parentModel }))
  on('session.start', ($, e) => e)
  const commands: { name: string }[] = []
  on('command.register', ($: unknown, e: { name: string }) => { commands.push(e); return { value: undefined } })
  on('turn.step', async function* () { return { answer: '', toolUses: [] } })
  on('process.run', ($: unknown, e: ProcessEvent) => {
    w.processes.push(e)
    if (setup.process) {
      const result = setup.process(e)
      if (result !== undefined) return result
    }
    if (s1.logFailure) return { deny: 'disk full' }
    if (e.argv[0] === 'uv') s1.noPython = false
    if (e.argv.includes('s1.setup') && !e.argv.includes('start')) {
      if (s1.noPython) return { value: { exitCode: 1, stdout: '', stderr: 'missing Python' } }
      s1.notReady = false
      s1.noSocket = false
      if (!s1.daemon || e.argv.includes('--restart')) s1.daemon = (s1.daemon ?? 0) + 1
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('fs.exists', ($: any, e: any) => ({ value: e.path === `${HOME}/.cache/s1-auto-router/ready.json` ? !s1.notReady
    : e.path === SOCKET ? !s1.noSocket : e.path.endsWith('/.venv/bin/python') ? !s1.noPython : Object.hasOwn(files, e.path) }))

  on('fs.read', async ($: any, e: any) => {
    if (setup.readBlock) await setup.readBlock
    if (setup.readErrors?.[e.path]) return { deny: setup.readErrors[e.path] }
    return e.path in files ? { value: files[e.path] } : { deny: `ENOENT ${e.path}` }
  })

  on('ui.log', ($: any, e: any) => { w.logs.push(e.text); return { value: undefined } })
  on('ui.toast', ($: any, e: any) => { w.toasts.push(e.text); if (s1.toastFailure) return { deny: 'toast unavailable' }; return { value: undefined } })
  on('http.fetch', async ($: any, e: any) => {
    w.requests.push({ url: e.url, socketPath: e.init?.socketPath, body: JSON.parse(e.init.body) })
    if (s1.refuse) return { deny: 'ECONNREFUSED' }
    if (s1.hang) await new Promise(() => {})
    if (s1.responseBlock) await s1.responseBlock
    const answers = Object.fromEntries(Object.entries(s1.answers ?? {}).map(([id, probs]) =>
      [id, { probs, confidence: Math.max(...Object.values(probs)) }]))
    const text = s1.text ?? JSON.stringify({ version: 1, model: s1.model ?? 'decider-2b-v11', answers })
    const status = s1.status ?? 200
    return { value: { status, ok: status < 300, headers: {}, text } }
  })
  on('tool.call', ($: any, e: any) => { w.spawned = e; return { result: 'ok' } })
  return Object.assign(w, { commands })
}

// Model-only fixtures pin Effort; Effort tests unset it explicitly.
const call = (extra: object = {}) => ({ tool: 'Agent', description: 'list files', prompt: 'List the files in src/', subagent_type: 'Explore', effort: 'high', ...extra }) as any
const yes = { yes: 0.9, no: 0.1 }
const no = { yes: 0.1, no: 0.9 }
const kind = (k: string) => Object.fromEntries(['locate', 'mechanical_edit', 'investigate', 'design', 'synthesize'].map(o => [o, o === k ? 0.8 : 0.05]))
const taggedPrompt = '<metadata><work-role>implementer</work-role><solution-space>Approach is settled.</solution-space></metadata><prompt>Implement the specified option and verify its behavior.</prompt>'

test('opt-in candidate lets prescribed low-risk feature implementation use Haiku', async ($, on) => {
  const w = world(on, { answers: {
    M1: kind('design'), M2: no, M3: no,
    E1: { clear: 1, partly_open: 0, very_open: 0 }, E2: no, E3: no,
  } }, { '/candidate.json': JSON.stringify(candidate) }, { S1_ROUTER_CONFIG: '/candidate.json' })
  await $.tool.call(call({ effort: undefined, prompt: taggedPrompt }))
  expect(w.spawned).toMatchObject({ model: 'haiku', effort: 'low', prompt: taggedPrompt })
  expect(w.requests[0].body.state).toMatchObject({ work_role: 'implementer', solution_space: 'Approach is settled.' })
  expect(w.requests[0].body.questions.find((q: any) => q.id === 'E1').text.includes('solution_space')).toBe(true)
})

test('candidate keeps costly prescribed implementation conservative for both outputs', async ($, on) => {
  const w = world(on, { answers: {
    M1: kind('design'), M2: no, M3: yes,
    E1: { clear: 1, partly_open: 0, very_open: 0 }, E2: no, E3: no,
  } }, { '/candidate.json': JSON.stringify(candidate) }, { S1_ROUTER_CONFIG: '/candidate.json' })
  await $.tool.call(call({ effort: undefined, prompt: taggedPrompt }))
  expect(w.spawned).toMatchObject({ model: 'opus', effort: 'medium' })
})

// These are rule checks with controlled S1 answers, not classification accuracy measurements.
const candidateAnswers = {
  M1: kind('design'), M2: no, M3: no,
  E1: { clear: 1, partly_open: 0, very_open: 0 }, E2: no, E3: no,
}
for (const [name, role, solution, answers, model, effort] of [
  ['partly open implementation', 'implementer', 'Choose the storage representation.', { E1: { clear: 0, partly_open: 1, very_open: 0 } }, 'sonnet', 'medium'],
  ['open implementation', 'implementer', 'The approach remains undecided.', { E1: { clear: 0, partly_open: 0, very_open: 1 }, E2: yes }, 'opus', 'high'],
  ['prescribed cross-component implementation', 'implementer', 'The approach is settled.', { M2: yes }, 'opus', 'low'],
  ['prescribed substantial verification', 'feature verification specialist', 'The approach is settled.', { E2: yes, E3: yes }, 'haiku', 'medium'],
  ['role describes work without restricting Haiku', 'architect', 'The approach is settled.', {}, 'haiku', 'low'],
] as [string, string, string, Record<string, Record<string, number>>, string, string][]) {
  test(`candidate routes ${name}`, async ($, on) => {
    const prompt = `<metadata><work-role>${role}</work-role><solution-space>${solution}</solution-space></metadata><prompt>Implement the requested feature and preserve existing behavior.</prompt>`
    const w = world(on, { answers: { ...candidateAnswers, ...answers } },
      { '/candidate.json': JSON.stringify(candidate) }, { S1_ROUTER_CONFIG: '/candidate.json' })
    await $.tool.call(call({ effort: undefined, prompt }))
    expect(w.spawned).toMatchObject({ model, effort, prompt })
    expect(w.requests[0].body.state).toMatchObject({ work_role: role, solution_space: solution,
      prompt: 'Implement the requested feature and preserve existing behavior.' })
  })
}

for (const [name, answers, explicit, parent, expected] of [
  ['uncertain interactions Abstain only Model', { M2: { yes: 0.55, no: 0.45 } }, {}, {}, { model: undefined, effort: 'low' }],
  ['uncertain workload Abstain only Effort', { E2: { yes: 0.55, no: 0.45 } }, {}, {}, { model: 'haiku', effort: undefined }],
  ['risky Model path does not require confident Solution Space', { M3: yes, E1: { clear: 0.4, partly_open: 0.3, very_open: 0.3 } }, {}, {}, { model: 'opus', effort: undefined }],
  ['Explicit Model is preserved', {}, { model: 'sonnet' }, {}, { model: 'sonnet', effort: 'low' }],
  ['Explicit Effort is preserved', {}, { effort: 'max' }, {}, { model: 'haiku', effort: 'max' }],
  ['Parent Ceiling applies to both outputs', { E1: { clear: 0, partly_open: 0, very_open: 1 }, E2: yes }, {}, { model: 'sonnet', effort: 'medium' }, { model: 'sonnet', effort: 'medium' }],
] as [string, Record<string, Record<string, number>>, object, any, any][]) {
  test(`candidate preserves routing control: ${name}`, async ($, on) => {
    const w = world(on, { answers: { ...candidateAnswers, ...answers } },
      { '/candidate.json': JSON.stringify(candidate) }, { S1_ROUTER_CONFIG: '/candidate.json' })
    if (parent.model) for await (const _ of $.turn.step(parent)) {}
    await $.tool.call(call({ effort: undefined, prompt: taggedPrompt, ...explicit }))
    expect(w.spawned.model).toBe(expected.model)
    expect(w.spawned.effort).toBe(expected.effort)
  })
}

test('candidate rules remain opt-in: default prescribed feature still selects Sonnet', async ($, on) => {
  const w = world(on, { answers: candidateAnswers })
  await $.tool.call(call({ effort: undefined, prompt: taggedPrompt }))
  expect(w.spawned).toMatchObject({ model: 'sonnet', effort: 'low' })
})

test('native Agent describes Parent-authored routing metadata without changing native guidance or placement', async ($, on) => {
  on('tool.describe', ($: any, e: any) => ({ description: e.description, isDeferred: true }))
  const result = await $.tool.describe({ tool: 'Agent', description: 'Native delegation instructions' } as any)
  expect(result.description.startsWith('Native delegation instructions')).toBe(true)
  for (const text of ['<metadata>', '<work-role>', '<solution-space>', '<prompt>', 'scout', 'implementer', 'architect', 'reviewer', 'synthesizer', 'unresolved', 'mistake cost']) {
    expect(result.description.includes(text)).toBe(true)
  }
  expect(result.isDeferred).toBe(true)
  expect(await $.tool.describe({ tool: 'Read', description: 'Read files' } as any)).toEqual({ description: 'Read files', isDeferred: true })
})

test('a denied known project agent definition fails open without replacing its Explicit values', async ($, on) => {
  const path = `${ROOT}/.claude/agents/pinned.md`
  const w = world(on, { answers: { M1: kind('locate'), M2: no, M3: no,
    E1: { clear: 1, partly_open: 0, very_open: 0 }, E2: no, E3: no } }, {
    [path]: '---\nmodel: opus\neffort: max\n---\n',
    [`${HOME}/.claude/agents/pinned.md`]: '---\ndescription: user fallback\n---\n',
  }, {}, { readErrors: { [path]: 'EACCES permission denied' } })
  await $.tool.call(call({ subagent_type: 'pinned', effort: undefined }))
  expect(w.spawned).toMatchObject(call({ subagent_type: 'pinned', effort: undefined }))
  expect(w.spawned.model).toBeUndefined()
  expect(w.spawned.effort).toBeUndefined()
  expect(w.requests).toHaveLength(0)
  expect(w.logs.some(l => l.includes('fail-open') && l.includes('EACCES'))).toBe(true)
})

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

test('Model Abstains on low confidence while Effort is still routed', async ($, on) => {
  const w = world(on, { answers: {
    M1: { locate: 0.4, mechanical_edit: 0.15, investigate: 0.15, design: 0.15, synthesize: 0.15 }, M2: no, M3: no,
    E1: { clear: 1, partly_open: 0, very_open: 0 }, E2: no, E3: no,
  } })
  await $.tool.call(call({ effort: undefined, prompt: taggedPrompt }))
  expect(w.spawned.model).toBeUndefined()
  expect(w.spawned.effort).toBe('low')
  expect(w.toasts).toEqual(['S1 → model abstain · low'])
})

test('the Parent sonnet/medium Ceiling clamps routed opus/high', async ($, on) => {
  const w = world(on, { answers: {
    M1: kind('design'), M2: yes, M3: no,
    E1: { clear: 0, partly_open: 0, very_open: 1 }, E2: yes, E3: yes,
  } })
  for await (const _ of $.turn.step({ model: 'claude-sonnet-5-5', effort: 'medium' } as any)) {}
  await $.tool.call(call({ effort: undefined, prompt: taggedPrompt }))
  expect(w.spawned).toMatchObject({ model: 'sonnet', effort: 'medium' })
  expect(w.toasts).toEqual(['S1 → sonnet (clamped from opus) · medium (clamped from high)'])
})

const unclear = { yes: 0.55, no: 0.45 }
for (const question of ['E1', 'E2', 'E3']) {
  test(`Effort Abstains when score term ${question} has low confidence, while Model still routes`, async ($, on) => {
    const w = world(on, { answers: {
      M1: kind('locate'), M2: no, M3: no,
      E1: { clear: 1, partly_open: 0, very_open: 0 }, E2: no, E3: no,
      [question]: question === 'E1' ? { clear: 0.4, partly_open: 0.3, very_open: 0.3 } : unclear,
    } })
    await $.tool.call(call({ effort: undefined, prompt: taggedPrompt }))
    expect(w.spawned.model).toBe('haiku')
    expect(w.spawned.effort).toBeUndefined()
    expect(w.toasts).toEqual(['S1 → haiku · effort abstain'])
  })
}

for (const [question, model] of [['M2', undefined], ['M3', 'haiku']] as const) {
  test(`Model confidence checks the taken path: uncertain ${question}`, async ($, on) => {
    const w = world(on, { answers: { M1: kind('locate'), M2: no, M3: no, [question]: unclear } })
    await $.tool.call(call())
    expect(w.spawned.model).toBe(model)
  })
}

test('confidence exactly at the threshold routes the Model', async ($, on) => {
  const w = world(on, { answers: {
    M1: { locate: 0.6, mechanical_edit: 0.1, investigate: 0.1, design: 0.1, synthesize: 0.1 }, M2: no, M3: no,
  } })
  await $.tool.call(call())
  expect(w.spawned.model).toBe('haiku')
})

const hardTask = {
  M1: kind('design'), M2: yes, M3: no,
  E1: { clear: 0, partly_open: 0, very_open: 1 }, E2: yes, E3: yes,
}
for (const [name, extra, files, env, expected, asks] of [
  ['call Explicit values', { model: 'opus', effort: 'max' }, {}, {}, { model: 'opus', effort: 'max' }, 0],
  ['frontmatter Explicit values', { subagent_type: 'pinned', effort: undefined }, { [`${ROOT}/.claude/agents/pinned.md`]: '---\nmodel: haiku\neffort: low\n---\n' }, {}, {}, 0],
  ['fork bypass', { subagent_type: 'fork' }, {}, {}, {}, 0],
  ['kill switch', {}, {}, { S1_ROUTER: 'off' }, {}, 0],
  ['constant trees', { effort: undefined }, { [`${ROOT}/.claude/s1-auto-router.json`]: JSON.stringify({ questions: {}, trees: { model: 'haiku', effort: 'low' } }) }, {}, { model: 'haiku', effort: 'low' }, 0],
] as [string, object, Record<string, string>, Record<string, string>, object, number][]) {
  test(`metadata preserves routing control: ${name}`, async ($, on) => {
    const w = world(on, { answers: hardTask }, files, env)
    await $.tool.call(call({ prompt: taggedPrompt, ...extra }))
    expect(w.spawned).toMatchObject(call({ prompt: taggedPrompt, ...extra, ...expected }))
    expect(w.requests).toHaveLength(asks)
  })
}
const ceilingCases: [string, object, Record<string, string>, object, string, string][] = [
  ['none lifts the Ceiling', { model: 'sonnet', effort: 'medium' }, { S1_ROUTER_CEILING: 'none' }, {}, 'opus', 'high'],
  ['Explicit opus is kept', { model: 'sonnet', effort: 'medium' }, {}, { model: 'opus' }, 'opus', 'medium'],
  ['Explicit max is kept', { model: 'sonnet', effort: 'medium' }, {}, { effort: 'max' }, 'sonnet', 'max'],
  ['haiku/low clamps both', { model: 'claude-haiku-5-5', effort: 'low' }, {}, {}, 'haiku', 'low'],
  ['fable/max allows the full Routing range', { model: 'fable', effort: 'max' }, {}, {}, 'opus', 'high'],
  ['opus/xhigh allows high Effort', { model: 'claude-opus-5-5', effort: 'xhigh' }, {}, {}, 'opus', 'high'],
  ['unknown Model leaves only Effort clamped', { model: 'unknown-provider', effort: 'medium' }, {}, {}, 'opus', 'medium'],
  ['unknown Effort leaves only Model clamped', { model: 'sonnet' }, {}, {}, 'sonnet', 'high'],
]
for (const [name, parent, env, explicit, model, effort] of ceilingCases) {
  test(`Ceiling: ${name}`, async ($, on) => {
    const w = world(on, { answers: hardTask }, {}, env)
    for await (const _ of $.turn.step(parent as any)) {}
    await $.tool.call(call({ effort: undefined, ...explicit }))
    expect(w.spawned).toMatchObject({ model, effort })
  })
}

test('the main Parent Model falls back to session.model while unknown Effort remains unclamped', async ($, on) => {
  const w = world(on, { answers: hardTask }, {}, {}, { parentModel: 'claude-sonnet-5-5' })
  await $.tool.call(call({ effort: undefined }))
  expect(w.spawned).toMatchObject({ model: 'sonnet', effort: 'high' })
})

test('each Parent uses its own latest step, and an unknown subagent Parent has no Ceiling', async ($, on) => {
  const w = world(on, { answers: hardTask }, {}, {}, { parentModel: 'sonnet' })
  for await (const _ of $.turn.step({ model: 'sonnet', effort: 'medium' } as any)) {}
  for await (const _ of $.turn.step({ agentId: 'child-a', model: 'haiku', effort: 'low' } as any)) {}
  await $.tool.call(call({ agentId: 'child-a', effort: undefined }))
  expect(w.spawned).toMatchObject({ model: 'haiku', effort: 'low' })
  await $.tool.call(call({ agentId: 'child-b', effort: undefined }))
  expect(w.spawned).toMatchObject({ model: 'opus', effort: 'high' })
  for await (const _ of $.turn.step({ agentId: 'child-a', model: 'sonnet', effort: 'high' } as any)) {}
  await $.tool.call(call({ agentId: 'child-a', effort: undefined }))
  expect(w.spawned).toMatchObject({ model: 'sonnet', effort: 'high' })
  await $.tool.call(call({ effort: undefined }))
  expect(w.spawned).toMatchObject({ model: 'sonnet', effort: 'medium' })
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

test('leading Parent metadata reaches S1 alongside the assignment while the child receives the original prompt', async ($, on) => {
  const w = world(on, { answers: { M1: kind('mechanical_edit'), M2: no, M3: no } })
  const prompt = '  <metadata>\n<work-role>implementer</work-role>\n<solution-space>Approach settled: add the named option and its specified test.</solution-space>\n</metadata>\n<prompt>Add the option in the supplied module. Test the documented behavior.</prompt>\n'
  await $.tool.call(call({ prompt }))
  expect(w.requests[0].body.state).toMatchObject({
    work_role: 'implementer', solution_space: 'Approach settled: add the named option and its specified test.',
    prompt: 'Add the option in the supplied module. Test the documented behavior.',
  })
  expect(w.spawned.prompt).toBe(prompt)
  expect(w.spawned.model).toBe('haiku')
})

for (const [name, fields, expected] of [
  ['missing role', '<solution-space>Two viable approaches remain.</solution-space>', { solution_space: 'Two viable approaches remain.' }],
  ['blank Solution Space', '<work-role>migration implementer</work-role><solution-space>  </solution-space>', { work_role: 'migration implementer' }],
  ['duplicate role', '<work-role>scout</work-role><work-role>architect</work-role><solution-space>Find the root cause.</solution-space>', { solution_space: 'Find the root cause.' }],
  ['invalid Solution Space', '<work-role>reviewer</work-role><solution-space><unknown>settled</unknown></solution-space>', { work_role: 'reviewer' }],
  ['unsupported field', '<model>opus</model><work-role>test author</work-role>', { work_role: 'test author' }],
] as const) {
  test(`metadata fallback retains usable fields independently: ${name}`, async ($, on) => {
    const w = world(on, { answers: { M1: kind('locate'), M2: no, M3: no } })
    const prompt = `<metadata>${fields}</metadata><prompt>Inspect the assigned module.</prompt>`
    await $.tool.call(call({ prompt }))
    expect(w.requests[0].body.state).toMatchObject({ ...expected, prompt: 'Inspect the assigned module.' })
    if (!('work_role' in expected)) expect(w.requests[0].body.state.work_role).toBeUndefined()
    if (!('solution_space' in expected)) expect(w.requests[0].body.state.solution_space).toBeUndefined()
    expect(w.requests[0].body.state.model).toBeUndefined()
    expect(w.spawned).toMatchObject({ model: 'haiku', prompt })
  })
}

for (const prompt of [
  'Explain this quoted example: <metadata><work-role>architect</work-role></metadata><prompt>example</prompt>',
  '```xml\n<metadata><work-role>architect</work-role></metadata><prompt>example</prompt>\n```',
  '<metadata><work-role>scout</work-role><prompt>Missing metadata close.</prompt>',
  '<metadata><work-role>scout</work-role></metadata><prompt>Missing assignment close.',
  '<metadata><work-role>scout</work-role></metadata><metadata><solution-space>open</solution-space></metadata><prompt>Inspect module.</prompt>',
  '<metadata>malformed <work-role>scout</work-role></metadata><prompt>Inspect module.</prompt>',
]) {
  test(`quoted or malformed metadata keeps ordinary inference and original task: ${prompt.slice(0, 60)}`, async ($, on) => {
    const w = world(on, { answers: { M1: kind('locate'), M2: no, M3: no } })
    await $.tool.call(call({ prompt }))
    expect(w.requests[0].body.state.prompt).toBe(prompt)
    expect(w.requests[0].body.state.work_role).toBeUndefined()
    expect(w.requests[0].body.state.solution_space).toBeUndefined()
    expect(w.spawned).toMatchObject({ model: 'haiku', prompt })
  })
}

test('assignment examples cannot replace the leading Parent metadata', async ($, on) => {
  const w = world(on, { answers: { M1: kind('locate'), M2: no, M3: no } })
  const assignment = 'Inspect this XML sample: <metadata><work-role>architect</work-role><solution-space>very open</solution-space></metadata>'
  const prompt = `<metadata><work-role>scout</work-role></metadata><prompt>${assignment}</prompt>`
  await $.tool.call(call({ prompt }))
  expect(w.requests[0].body.state).toMatchObject({ work_role: 'scout', prompt: assignment })
  expect(w.requests[0].body.state.solution_space).toBeUndefined()
  expect(w.spawned.prompt).toBe(prompt)
})

test('metadata is interpreted before a small content budget is applied, sharing that budget with the assignment', async ($, on) => {
  const w = world(on, { answers: { costly: no } }, { [`${ROOT}/.claude/s1-auto-router.json`]: customConfig({ if: 'costly', then: 'sonnet', else: 'haiku' }, 'medium', { prompt_max_chars: 40, questions: { costly: { type: 'yesno', text: 'Costly?' } } }) })
  const prompt = `<metadata><work-role>scout</work-role><solution-space>settled</solution-space></metadata><prompt>${'a'.repeat(100)}</prompt>`
  await $.tool.call(call({ prompt }))
  expect(w.requests[0].body.state).toMatchObject({ work_role: 'scout', solution_space: 'settled', prompt: 'a'.repeat(28) })
  expect(w.spawned.prompt).toBe(prompt)
})

test('an oversized metadata field is inferred instead of crowding out assignment context or being cut into a partial hint', async ($, on) => {
  const w = world(on, { answers: { M1: kind('locate'), M2: no, M3: no } })
  const prompt = `<metadata><work-role>scout</work-role><solution-space>${'x'.repeat(2500)}</solution-space></metadata><prompt>${'a'.repeat(5000)}</prompt>`
  await $.tool.call(call({ prompt }))
  expect(w.requests[0].body.state).toMatchObject({ work_role: 'scout', prompt: 'a'.repeat(3995) })
  expect(w.requests[0].body.state.solution_space).toBeUndefined()
  expect(w.spawned.prompt).toBe(prompt)
})

test('a metadata block outside the bounded structural prefix safely uses ordinary inference', async ($, on) => {
  const w = world(on, { answers: { M1: kind('locate'), M2: no, M3: no } })
  const prompt = `<metadata><work-role>scout</work-role><solution-space>${'x'.repeat(5000)}</solution-space></metadata><prompt>Inspect module.</prompt>`
  await $.tool.call(call({ prompt }))
  expect(w.requests[0].body.state.prompt).toBe(prompt.slice(0, 4000))
  expect(w.requests[0].body.state.work_role).toBeUndefined()
  expect(w.spawned).toMatchObject({ model: 'haiku', prompt })
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
  ['confidence contradicting the probabilities', { text: JSON.stringify({ version: 1, model: 'm', answers: {
    M1: { probs: kind('locate'), confidence: 1 }, M2: { probs: no, confidence: 0.9 }, M3: { probs: no, confidence: 0.9 },
  } }) }],
]
const invalidAnswers: [string, object][] = [
  ['negative probability', { probs: { yes: -0.1, no: 1.1 }, confidence: 1.1 }],
  ['non-normalized probabilities', { probs: { yes: 0.1, no: 0.8 }, confidence: 0.8 }],
  ['an unknown option', { probs: { yes: 0.1, no: 0.8, maybe: 0.1 }, confidence: 0.8 }],
  ['array probabilities', { probs: [0.1, 0.9], confidence: 0.9 }],
  ['missing confidence', { probs: no }],
  ['null confidence', { probs: no, confidence: null }],
  ['nonnumeric confidence', { probs: no, confidence: '0.9' }],
]
for (const [name, answer] of invalidAnswers) failures.push([name, { text: JSON.stringify({
  version: 1, model: 'm', answers: { M1: { probs: kind('locate'), confidence: 0.8 }, M2: answer, M3: { probs: no, confidence: 0.9 } },
}) }])
for (const model of [undefined, '', '   ', 42]) failures.push([`invalid Decider model ${JSON.stringify(model)}`, { text: JSON.stringify({
  version: 1, model, answers: {
    M1: { probs: kind('locate'), confidence: 0.8 }, M2: { probs: no, confidence: 0.9 }, M3: { probs: no, confidence: 0.9 },
  },
}) }])
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
  expect(w.logs.some(l => l.includes('S1 timeout over 5000 ms'))).toBe(true)
  expect(w.processes).toHaveLength(0)
})

test('the total 5 s budget includes definition reads, with no late request or toast', async ($, on) => {
  let release!: () => void
  const readBlock = new Promise<void>(resolve => { release = resolve })
  const w = world(on, { answers: { M1: kind('locate'), M2: no, M3: no } },
    { [`${ROOT}/.claude/agents/Explore.md`]: '---\ndescription: finds things\n---\n' }, {}, { readBlock })
  const p = $.tool.call(call())
  await w.clock.advance(5001)
  expect(w.spawned).toMatchObject(call())
  expect(w.spawned.model).toBeUndefined()
  await p
  release()
  await w.clock.advance(1000)
  expect(w.requests).toHaveLength(0)
  expect(w.toasts).toEqual([])
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
  const entries = w.processes.filter(p => p.init?.stdin).map(p => JSON.parse(p.init.stdin))
  expect(entries).toHaveLength(2)
  expect(entries[0].reasons.skip).toBe('S1 not set up')
})


test('a Spawn with no socket starts S1 and fails open, then later Spawns route', async ($, on) => {
  const s1 = { noSocket: true, answers: { M1: kind('locate'), M2: no, M3: no } }
  const w = world(on, s1)
  await $.tool.call(call())
  expect(w.spawned.model).toBeUndefined()
  expect(w.requests).toHaveLength(0)
  expect(w.processes.filter(p => p.argv.includes('s1.setup'))).toHaveLength(1)
  expect(w.processes[0].argv.slice(1)).toEqual(['-m', 's1.setup', 'start'])
  expect(JSON.parse(w.processes[1].init.stdin).reasons.skip).toBe('S1 cold start')
  s1.noSocket = false
  await $.tool.call(call())
  expect(w.spawned.model).toBe('haiku')
})

const customConfig = (model: unknown = 'sonnet', effort: unknown = 'medium', extra: object = {}) => JSON.stringify({
  questions: {}, trees: { model, effort }, ...extra,
})

test('a denied known project Routing Config fails open instead of selecting the user config', async ($, on) => {
  const path = `${ROOT}/.claude/s1-auto-router.yaml`
  const w = world(on, {}, { [path]: customConfig('haiku', 'low'),
    [`${HOME}/.claude/s1-auto-router.json`]: customConfig('opus', 'high'),
  }, {}, { readErrors: { [path]: 'EIO cannot read config' } })
  await $.tool.call(call({ effort: undefined }))
  expect(w.spawned).toMatchObject(call({ effort: undefined }))
  expect(w.spawned.model).toBeUndefined()
  expect(w.spawned.effort).toBeUndefined()
  expect(w.requests).toHaveLength(0)
  expect(w.toasts.some(t => t.startsWith('S1 Routing Config invalid:') && t.includes('EIO'))).toBe(true)
})

for (const option of ['toString', 'constructor', '__proto__']) {
  test(`a custom switch option ${option} uses its default and does not discard independent Effort routing`, async ($, on) => {
    const w = world(on, { answers: { work: { [option]: 0.9, ordinary: 0.1 } } }, {
      [`${ROOT}/.claude/s1-auto-router.json`]: customConfig({ switch: 'work', cases: { ordinary: 'haiku' }, default: 'sonnet' }, 'medium', {
        questions: { work: { type: 'choice', text: 'What work is needed?', options: [
          { id: option, description: 'work that takes the default branch' }, { id: 'ordinary', description: 'a simple lookup' },
        ] } },
      }),
    })
    await $.tool.call(call({ effort: undefined }))
    expect(w.spawned).toMatchObject({ model: 'sonnet', effort: 'medium' })
    expect(w.toasts).toEqual(['S1 → sonnet · medium'])
  })
}

test('the env Routing Config wins whole over project and user files', async ($, on) => {
  const w = world(on, { noSocket: true }, {
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

test('a readable first YAML config routes and warns about an unreadable lower-priority JSON file', async ($, on) => {
  const ignored = `${ROOT}/.claude/s1-auto-router.json`
  const w = world(on, { answers: { costly: yes } }, {
    [`${ROOT}/.claude/s1-auto-router.yaml`]: yamlCustom,
    [ignored]: customConfig('haiku', 'low'),
  }, {}, { readErrors: { [ignored]: 'EACCES ignored JSON is unreadable' } })
  await $.tool.call(call({ effort: undefined }))
  expect(w.spawned).toMatchObject({ model: 'opus', effort: 'medium' })
  expect(w.toasts).toEqual([
    `S1 Routing Config: several formats found; using ${ROOT}/.claude/s1-auto-router.yaml`, 'S1 → opus · medium',
  ])
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
  const entry = JSON.parse(w.processes[0].init.stdin)
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


test('constant Model and Effort trees route after setup without a socket or S1 start', async ($, on) => {
  const w = world(on, { noSocket: true, refuse: true }, { [`${ROOT}/.claude/s1-auto-router.json`]: customConfig('sonnet', 'medium') })
  await $.tool.call(call({ effort: undefined, prompt: taggedPrompt }))
  expect(w.spawned).toMatchObject({ model: 'sonnet', effort: 'medium', prompt: taggedPrompt })
  expect(w.requests).toHaveLength(0)
  expect(w.processes.filter(p => p.argv.includes('s1.setup'))).toHaveLength(0)
  const entry = JSON.parse(w.processes[0].init.stdin)
  expect(entry.latency_ms).toBe(null)
  expect(entry.s1_model).toBe(null)
})

test('constant trees still fail open before setup without starting S1', async ($, on) => {
  const w = world(on, { notReady: true, noSocket: true }, { [`${ROOT}/.claude/s1-auto-router.json`]: customConfig('sonnet', 'medium') })
  await $.tool.call(call({ effort: undefined }))
  expect(w.spawned).toMatchObject(call({ effort: undefined }))
  expect(w.spawned.model).toBeUndefined()
  expect(w.requests).toHaveLength(0)
  expect(w.processes.filter(p => p.argv.includes('s1.setup'))).toHaveLength(0)
  expect(JSON.parse(w.processes[0].init.stdin).reasons.skip).toBe('S1 not set up')
})

for (const source of ['call', 'frontmatter']) {
  test(`an Explicit Model from ${source} removes inference for a mixed config without a socket`, async ($, on) => {
    const w = world(on, { noSocket: true }, {
      [`${ROOT}/.claude/s1-auto-router.json`]: customConfig({ if: 'costly', then: 'opus', else: 'haiku' }, 'medium', {
        questions: { costly: { type: 'yesno', text: 'Costly?' } },
      }),
      ...(source === 'frontmatter' ? { [`${ROOT}/.claude/agents/Explore.md`]: '---\nmodel: sonnet\n---\n' } : {}),
    })
    await $.tool.call(call({ effort: undefined, ...(source === 'call' ? { model: 'sonnet' } : {}) }))
    expect(w.spawned.effort).toBe('medium')
    expect(w.spawned.model).toBe(source === 'call' ? 'sonnet' : undefined)
    expect(w.requests).toHaveLength(0)
    expect(w.processes.filter(p => p.argv.includes('s1.setup'))).toHaveLength(0)
    expect(JSON.parse(w.processes[0].init.stdin).explicit.model).toBe('sonnet')
  })
}


test('the decision log distinguishes raw values, Parent Ceiling clamps and the applied values', async ($, on) => {
  const w = world(on, { noSocket: true }, { [`${ROOT}/.claude/s1-auto-router.json`]: customConfig('opus', 'high') })
  for await (const _ of $.turn.step({ model: 'sonnet', effort: 'medium' } as any)) {}
  await $.tool.call(call({ effort: undefined }))
  const entry = JSON.parse(w.processes[0].init.stdin)
  expect(entry).toMatchObject({ parent: { model: 'sonnet', effort: 'medium' }, ceiling: 'parent', raw: { model: 'opus', effort: 'high' }, applied: { model: 'sonnet', effort: 'medium' } })
  expect(entry.reasons.model).toBe('clamp')
  expect(entry.reasons.effort).toBe('clamp')
})

test('the decision log records Abstain with raw output, probabilities and no applied value', async ($, on) => {
  const w = world(on, { answers: { M1: { locate: 0.55, mechanical_edit: 0.15, investigate: 0.1, design: 0.1, synthesize: 0.1 }, M2: no, M3: no } })
  await $.tool.call(call())
  const entry = JSON.parse(w.processes[0].init.stdin)
  expect(entry.raw.model).toBe('haiku')
  expect(entry.applied).toEqual({})
  expect(entry.reasons.model).toBe('abstain')
  expect(entry.probabilities.M1.confidence).toBe(0.55)
})

test('an invalid config still records the known Parent and fail-open reason', async ($, on) => {
  const w = world(on, {}, { [`${ROOT}/.claude/s1-auto-router.json`]: customConfig('fable') })
  for await (const _ of $.turn.step({ model: 'sonnet', effort: 'medium' } as any)) {}
  await $.tool.call(call({ effort: undefined }))
  const entry = JSON.parse(w.processes[0].init.stdin)
  expect(entry.parent).toEqual({ model: 'sonnet', effort: 'medium' })
  expect(entry.reasons.fail_open).toBe('Invalid model value fable')
  expect(entry.applied).toEqual({})
})


test('the 5 s Routing budget includes a blocked kill-switch env read and suppresses late work', async ($, on) => {
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  const w = world(on, { answers: { M1: kind('locate'), M2: no, M3: no } }, {}, {}, { envBlock: { name: 'S1_ROUTER', wait } })
  const pending = $.tool.call(call())
  await w.clock.advance(5001)
  try { expect(w.spawned).toMatchObject(call()) }
  finally { release(); await w.clock.advance(1000); await pending }
  expect(w.spawned.model).toBeUndefined()
  expect(w.requests).toHaveLength(0)
  expect(w.toasts).toEqual([])
})

test('a blocked log HOME read is bounded and cannot trigger a late append', async ($, on) => {
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  let w: ReturnType<typeof world>
  w = world(on, { answers: { M1: kind('locate'), M2: no, M3: no } }, {}, {}, { envBlock: { name: 'HOME', wait, when: () => w.requests.length > 0 } })
  const pending = $.tool.call(call())
  await w.clock.advance(1001)
  try { expect(w.spawned.model).toBe('haiku') }
  finally { release(); await w.clock.advance(1000); await pending }
  expect(w.processes).toHaveLength(0)
  expect(w.logs.some(l => l.includes('decision log failed'))).toBe(true)
})

test('a hung S1 request and blocked logging release the fallback Spawn at the total 5 s deadline', async ($, on) => {
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  let w: ReturnType<typeof world>
  w = world(on, { hang: true }, {}, {}, { envBlock: { name: 'HOME', wait, when: () => w.logs.some(l => l.includes('fail-open')) } })
  const pending = $.tool.call(call())
  await w.clock.advance(4999)
  expect(w.spawned).toBeUndefined()
  await w.clock.advance(1)
  try { expect(w.spawned).toMatchObject(call()) }
  finally { release(); await w.clock.advance(1001); await pending }
  expect(w.spawned.model).toBeUndefined()
  expect(w.processes).toHaveLength(0)
  expect(w.logs.some(l => l.includes('S1 timeout over 5000 ms'))).toBe(true)
})

test('a late Routing result survives blocked logging and proceeds at the total deadline without a late append', async ($, on) => {
  let respond!: () => void
  let release!: () => void
  const responseBlock = new Promise<void>(resolve => { respond = resolve })
  const wait = new Promise<void>(resolve => { release = resolve })
  let w: ReturnType<typeof world>
  w = world(on, { responseBlock, answers: { M1: kind('locate'), M2: no, M3: no } }, {}, {},
    { envBlock: { name: 'HOME', wait, when: () => w.requests.length > 0 } })
  const pending = $.tool.call(call())
  await w.clock.advance(4500)
  respond()
  await w.clock.advance(499)
  expect(w.spawned).toBeUndefined()
  await w.clock.advance(1)
  try { expect(w.spawned).toMatchObject({ ...call(), model: 'haiku' }) }
  finally { release(); await w.clock.advance(1001); await pending }
  expect(w.processes).toHaveLength(0)
  expect(w.logs.some(l => l.includes('decision log failed'))).toBe(true)
})

test('the decision writer process receives only the time left in the total Routing budget', async ($, on) => {
  let respond!: () => void
  const responseBlock = new Promise<void>(resolve => { respond = resolve })
  const w = world(on, { responseBlock, answers: { M1: kind('locate'), M2: no, M3: no } })
  const pending = $.tool.call(call())
  await w.clock.advance(4500)
  respond()
  await w.clock.advance(0)
  await pending
  expect(w.spawned.model).toBe('haiku')
  expect(w.processes[0].init.timeoutMs).toBe(500)
})

for (const [name, initial] of [
  ['shared ready marker with missing plugin Python', { noPython: true, noSocket: true }],
  ['unprepared cache', { noPython: true, notReady: true, noSocket: true }],
  ['cached environment with a cold daemon', { notReady: true, noSocket: true }],
  ['healthy shared daemon', { daemon: 17 }],
] as [string, S1][]) {
  test(`session startup prepares the first Spawn: ${name}`, async ($, on) => {
    const s1: S1 = { ...initial, answers: { M1: kind('locate'), M2: no, M3: no,
      E1: { clear: 1, partly_open: 0, very_open: 0 }, E2: no, E3: no } }
    const w = world(on, s1, {}, {}, { process: () => {
      expect(w.commands.some(command => command.name === 's1-setup')).toBe(true)
    } })
    const result = await $.session.start({ cwd: ROOT })
    expect(result).toEqual({ cwd: ROOT })
    await $.tool.call(call({ effort: undefined }))
    expect(w.spawned).toMatchObject({ model: 'haiku', effort: 'low' })
    expect(w.requests).toHaveLength(1)
    expect(Boolean(s1.noPython)).toBe(false)
    expect(s1.notReady).toBe(false)
    expect(s1.noSocket).toBe(false)
    expect(s1.daemon).toBe(initial.daemon ?? 1)
    expect(w.processes.filter(process => process.argv[0] === 'uv')).toHaveLength(initial.noPython ? 1 : 0)
  })
}

for (const variable of ['S1_AUTO_START', 'S1_ROUTER']) {
  test(`${variable}=off suppresses startup but explicit setup repairs Routing`, async ($, on) => {
    const env: Record<string, string> = { [variable]: 'off' }
    const s1: S1 = { noPython: true, notReady: true, noSocket: true,
      answers: { M1: kind('locate'), M2: no, M3: no, E1: { clear: 1, partly_open: 0, very_open: 0 }, E2: no, E3: no } }
    const w = world(on, s1, {}, env)
    await $.session.start({ cwd: ROOT })
    expect(w.processes).toHaveLength(0)
    expect(w.commands.some(command => command.name === 's1-setup')).toBe(true)
    await $.tool.call(call({ effort: undefined }))
    expect(w.spawned.model).toBeUndefined()
    const result = await $.command.run({ command: 's1-setup', args: '' })
    expect(result.exitCode).toBe(0)
    // Router off disables Routing itself; explicit setup must still prepare it.
    delete env.S1_ROUTER
    await $.tool.call(call({ effort: undefined }))
    expect(w.spawned).toMatchObject({ model: 'haiku', effort: 'low' })
  })
}

for (const failure of ['sync', 'setup', 'throw', 'invalid model']) {
  test(`automatic ${failure} failure preserves session, command and fail-open Spawn`, async ($, on) => {
    const env: Record<string, string> = failure === 'invalid model' ? { S1_MODEL: 'invalid' } : {}
    let fail = true
    const s1: S1 = { noPython: true, notReady: true, noSocket: true, toastFailure: true,
      answers: { M1: kind('locate'), M2: no, M3: no } }
    const w = world(on, s1, {}, env, { process: e => {
      if (!fail || e.argv.includes('append_log.py')) return
      if (failure === 'throw') throw new Error('uv unavailable')
      if ((failure === 'sync' && e.argv[0] === 'uv') || (failure === 'setup' && e.argv.includes('s1.setup'))) {
        return { value: { exitCode: 1, stdout: '', stderr: 'setup unavailable' } }
      }
    } })
    expect(await $.session.start({ cwd: ROOT })).toEqual({ cwd: ROOT })
    expect(w.commands.some(command => command.name === 's1-setup')).toBe(true)
    expect(w.logs.some(text => text.includes('automatic setup failed') && text.includes('/s1-setup'))).toBe(true)
    expect(w.toasts.some(text => text.includes('/s1-setup'))).toBe(true)
    await $.tool.call(call())
    expect(w.spawned.model).toBeUndefined()
    expect(w.requests).toHaveLength(0)
    fail = false
    delete env.S1_MODEL
    expect((await $.command.run({ command: 's1-setup', args: '' })).exitCode).toBe(0)
    await $.tool.call(call())
    expect(w.spawned.model).toBe('haiku')
  })
}

test('explicit setup refreshes a cached environment and restart replaces the daemon', async ($, on) => {
  const s1: S1 = { daemon: 17, answers: { M1: kind('locate'), M2: no, M3: no } }
  const w = world(on, s1, {}, { S1_AUTO_START: 'off' })
  await $.session.start({ cwd: ROOT })
  expect((await $.command.run({ command: 's1-setup', args: '' })).exitCode).toBe(0)
  expect(s1.daemon).toBe(17)
  expect((await $.command.run({ command: 's1-setup', args: '--restart' })).exitCode).toBe(0)
  expect(s1.daemon).toBe(18)
  expect(w.processes.filter(process => process.argv[0] === 'uv')).toHaveLength(2)
  await $.tool.call(call())
  expect(w.spawned.model).toBe('haiku')
})
