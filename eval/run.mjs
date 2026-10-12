// Manual real-model eval. Node >=24 uses the same TypeScript routing code without a build step.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { arch, cpus, homedir, platform, release, totalmem } from 'node:os'
import { dirname } from 'node:path'
import { DEFAULT_CONFIG } from '../hooks/default-config.ts'
import { SOLUTION_SPACE_CONFIG } from '../hooks/solution-space-candidate.ts'
import { parseConfig } from '../hooks/config.ts'
import { questionsOf, walk } from '../hooks/tree.ts'
import { buildState } from '../hooks/state.ts'
import { BUDGET_MS, parseResponse, requestBody, socketPath } from '../hooks/s1-client.ts'

const fixtures = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url)))
const outputs = ['model', 'effort']
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]
const labels = { model: ['haiku', 'sonnet', 'opus'], effort: ['low', 'medium', 'high'] }
const sha256 = value => createHash('sha256').update(value).digest('hex')
let report
let reportPath

function saveReport() {
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  chmodSync(reportPath, 0o600)
}
assert(fixtures.length >= 20 && fixtures.length <= 30, '20–30 approved cases required')
assert.equal(new Set(fixtures.map(f => f.id)).size, fixtures.length)
for (const f of fixtures) {
  assert(f.description && f.prompt && f.subagent_type, `incomplete fixture ${f.id}`)
  for (const output of outputs) assert(labels[output].includes(f.expected[output]), `bad ${output} label ${f.id}`)
}
assert.deepEqual([...new Set(fixtures.map(f => f.coverage.kind))].sort(), ['design', 'investigate', 'locate', 'mechanical_edit', 'synthesize'])
assert.deepEqual([...new Set(fixtures.map(f => f.coverage.openness))].sort(), ['clear', 'partly_open', 'very_open'])
assert.equal(percentile([40, 10, 30, 20], .5), 20)
assert.equal(percentile([40, 10, 30, 20], .95), 40)

function decide(answers, ms, config) {
  return Object.fromEntries(outputs.map(output => {
    const { value, path } = walk(config.trees[output], answers)
    return [output, ms > BUDGET_MS ? 'fail-open'
      : path.some(id => answers[id].confidence < config.threshold) ? 'abstain' : value]
  }))
}

function summarize(records, config) {
  return Object.fromEntries(outputs.map(output => {
    const counts = { correct: 0, wrong: 0, abstain: 0, 'fail-open': 0 }
    for (const r of records) {
      const value = decide(r.answers, r.ms, config)[output]
      const bucket = value === 'abstain' || value === 'fail-open' ? value
        : !r.expected ? 'unlabeled' : value === r.expected[output] ? 'correct' : 'wrong'
      counts[bucket] = (counts[bucket] ?? 0) + 1
    }
    return [output, counts]
  }))
}

function ask(socket, state, questions) {
  if (!Object.keys(questions).length) return Promise.resolve({ model: 'constant trees (no S1)', answers: {}, ms: 0 })
  return new Promise((resolve, reject) => {
    const body = requestBody(state, questions)
    const started = performance.now()
    const req = request({ socketPath: socket, path: '/v1/answer', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { text += chunk })
      res.on('error', reject)
      res.on('end', () => {
        try {
          const parsed = parseResponse({ status: res.statusCode, ok: res.statusCode === 200, text }, questions)
          resolve({ ...parsed, ms: performance.now() - started })
        } catch (error) { reject(error) }
      })
    })
    req.setTimeout(30_000, () => req.destroy(new Error('S1 did not respond within 30s')))
    req.on('error', reject)
    req.end(body)
  })
}

async function main() {
  if (process.argv[2] === '--check') {
    assert.deepEqual(parseConfig(readFileSync(new URL('../hooks/default-config.yaml', import.meta.url), 'utf8')), DEFAULT_CONFIG,
      'shipped YAML defaults must match production Routing Config')
    assert.deepEqual(parseConfig(readFileSync(new URL('../hooks/solution-space-candidate.json', import.meta.url), 'utf8')), SOLUTION_SPACE_CONFIG,
      'selectable candidate JSON must match the native Agent test configuration')
    // Counts must separate a confident wrong result from an uncertain unanswered one.
    const example = { trees: { model: { if: 'q', then: 'opus', else: 'haiku' }, effort: 'low' }, threshold: .6 }
    const records = [{ expected: { model: 'haiku', effort: 'low' }, ms: 10,
      answers: { q: { probs: { yes: .9, no: .1 }, confidence: .9 } } },
      { expected: { model: 'haiku', effort: 'low' }, ms: 10,
        answers: { q: { probs: { yes: .55, no: .45 }, confidence: .55 } } }]
    assert.deepEqual(summarize(records, example), {
      model: { correct: 0, wrong: 1, abstain: 1, 'fail-open': 0 },
      effort: { correct: 2, wrong: 0, abstain: 0, 'fail-open': 0 },
    })
    assert.deepEqual(decide(records[0].answers, 5001, example), { model: 'fail-open', effort: 'fail-open' })
    assert.deepEqual(summarize([{ answers: records[0].answers, ms: 10 }], example), {
      model: { correct: 0, wrong: 0, abstain: 0, 'fail-open': 0, unlabeled: 1 },
      effort: { correct: 0, wrong: 0, abstain: 0, 'fail-open': 0, unlabeled: 1 },
    }, 'unlabeled calibration observations must not become accuracy targets')
    assert.deepEqual(await ask('/no-such-socket', {}, {}), { model: 'constant trees (no S1)', answers: {}, ms: 0 })
    const observations = JSON.parse(readFileSync(new URL('./solution-space-observations.json', import.meta.url)))
    assert.equal(observations.length, 8)
    assert.equal(new Set(observations.map(f => f.id)).size, observations.length)
    for (const f of observations) assert(f.description && f.prompt && f.subagent_type && !f.expected,
      'metadata calibration cases are unlabeled observations, not approved targets')
    console.log('Eval self-check passed: shipped defaults and candidate, labels/coverage, unlabeled observations, percentile ordering, wrong vs Abstain, 5s fail-open.')
    return
  }
  if (process.argv.length > 6) throw new Error('Usage: node eval/run.mjs [socket] [config.yaml|json] [cases.json] [report.json] | --check')
  const socket = process.argv[2] ?? socketPath(homedir())
  const config = process.argv[3] ? parseConfig(readFileSync(process.argv[3], 'utf8')) : DEFAULT_CONFIG
  const cases = process.argv[4] ? JSON.parse(readFileSync(process.argv[4], 'utf8')) : fixtures
  assert(Array.isArray(cases) && cases.length, 'cases must be a nonempty array')
  assert.equal(new Set(cases.map(f => f.id)).size, cases.length, 'case IDs must be unique')
  for (const f of cases) {
    assert(f.id && f.description && f.prompt && f.subagent_type, `incomplete case ${f.id}`)
    if (f.expected) for (const output of outputs) assert(labels[output].includes(f.expected[output]), `bad ${output} label ${f.id}`)
  }
  reportPath = process.argv[5] ?? '.scratch/s1-eval-results.json'
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', cwd: new URL('../', import.meta.url) }).trim()
  report = { timestamp: new Date().toISOString(), status: 'running', node: process.version,
    identities: { baseline_commit: '3c64fef', plugin_commit: git('rev-parse', 'HEAD'), plugin_tree: git('rev-parse', 'HEAD^{tree}'),
      tracked_changes: git('status', '--porcelain', '--untracked-files=no'), config_sha256: sha256(JSON.stringify(config)),
      corpus_sha256: sha256(JSON.stringify(cases)), runner_sha256: sha256(readFileSync(new URL('./run.mjs', import.meta.url))),
      approved_fixtures_sha256: sha256(readFileSync(new URL('./fixtures.json', import.meta.url))) },
    hardware: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, memory_bytes: totalmem() },
    socket, config, model: null, summary: null, latency: null, records: [], benchmarks: [],
    evidence: 'S1 request/classification only; no Parent Ceiling, hook wall latency, child task outcomes or monetary cost.' }
  const ids = []
  for (const output of outputs) questionsOf(config.trees[output], ids)
  const questions = Object.fromEntries(ids.map(id => [id, config.questions[id]]))
  const records = []
  // Warm up without including cold inference in the latency percentiles.
  const warmup = await ask(socket, buildState(cases[0], { frontmatter: {} }, undefined, config.prompt_max_chars), questions)
  report.model = warmup.model
  for (const f of cases) {
    const state = buildState(f, { frontmatter: {} }, undefined, config.prompt_max_chars)
    const result = await ask(socket, state, questions)
    const actual = decide(result.answers, result.ms, config)
    const disagreements = outputs.filter(output => f.expected && labels[output].includes(actual[output]) && actual[output] !== f.expected[output])
    const target = f.expected ? `expected ${f.expected.model}/${f.expected.effort}` : 'unlabeled observation'
    console.log(`${f.id}: ${target}, got ${actual.model}/${actual.effort}, ${result.ms.toFixed(0)} ms${disagreements.length ? ` WRONG ${disagreements.join(',')}` : ''}`)
    records.push({ ...f, state, ...result, actual })
    report.records = records
  }
  const summary = summarize(records, config)
  const latency = { p50: percentile(records.map(r => r.ms), .5), p95: percentile(records.map(r => r.ms), .95) }
  console.log(`\n${records[0].model}; confidence ${config.threshold}, prompt limit ${config.prompt_max_chars}`)
  console.log('Summary', JSON.stringify(summary), 'latency ms', JSON.stringify(latency))
  for (const threshold of [.4, .5, .6, .7, .8])
    console.log(`Confidence replay ${threshold}:`, JSON.stringify(summarize(records, { ...config, threshold })))
  for (const high of [2, 2.5, 3]) {
    const candidate = structuredClone(config)
    if (!candidate.trees.effort.thresholds) continue
    candidate.trees.effort.thresholds.high = high
    console.log(`Effort high replay ${high}:`, JSON.stringify(summarize(records, candidate)))
  }
  const long = JSON.parse(readFileSync(new URL('./long-state.json', import.meta.url)))
  const benchmarks = []
  for (const limit of process.argv[4] ? [] : [2000, 4000]) {
    const state = { ...long, prompt: long.prompt.slice(0, limit) }
    await ask(socket, state, questions)
    const samples = []
    for (let i = 0; i < 5; i++) samples.push(await ask(socket, state, questions))
    const row = { limit, p50: percentile(samples.map(r => r.ms), .5), p95: percentile(samples.map(r => r.ms), .95),
      actual: decide(samples[0].answers, samples[0].ms, config), answers: samples[0].answers }
    benchmarks.push(row)
    console.log(`Long prompt ${limit}:`, JSON.stringify({ ...row, answers: undefined }))
  }
  Object.assign(report, { status: 'measured', summary, latency, records, benchmarks })
  saveReport()
  console.log(`Raw answers/config/identities/measurements: ${reportPath} (nearest-rank p50/p95; no Parent Ceiling).`)
}

main().catch(error => {
  if (report) {
    Object.assign(report, { status: 'infrastructure-blocked', error: { code: error.code ?? null, message: error.message } })
    saveReport()
  }
  console.error(`Eval failed: ${error.message}. Start S1 with /s1-setup or pass its socket.`)
  process.exitCode = 1
})
