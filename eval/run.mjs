// Manual real-model eval. Node >=24 uses the same TypeScript routing code without a build step.
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { homedir } from 'node:os'
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
      counts[value === 'abstain' || value === 'fail-open' ? value : value === r.expected[output] ? 'correct' : 'wrong']++
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
    assert.deepEqual(await ask('/no-such-socket', {}, {}), { model: 'constant trees (no S1)', answers: {}, ms: 0 })
    console.log('Eval self-check passed: shipped defaults and candidate, labels/coverage, percentile ordering, wrong vs Abstain, 5s fail-open.')
    return
  }
  if (process.argv.length > 4) throw new Error('Usage: node eval/run.mjs [socket] [config.yaml|json] | --check')
  const socket = process.argv[2] ?? socketPath(homedir())
  const config = process.argv[3] ? parseConfig(readFileSync(process.argv[3], 'utf8')) : DEFAULT_CONFIG
  const ids = []
  for (const output of outputs) questionsOf(config.trees[output], ids)
  const questions = Object.fromEntries(ids.map(id => [id, config.questions[id]]))
  const records = []
  // Warm up without including cold inference in the latency percentiles.
  await ask(socket, buildState(fixtures[0], { frontmatter: {} }, undefined, config.prompt_max_chars), questions)
  for (const f of fixtures) {
    const state = buildState(f, { frontmatter: {} }, undefined, config.prompt_max_chars)
    const result = await ask(socket, state, questions)
    const actual = decide(result.answers, result.ms, config)
    const disagreements = outputs.filter(output => labels[output].includes(actual[output]) && actual[output] !== f.expected[output])
    console.log(`${f.id}: expected ${f.expected.model}/${f.expected.effort}, got ${actual.model}/${actual.effort}, ${result.ms.toFixed(0)} ms${disagreements.length ? ` WRONG ${disagreements.join(',')}` : ''}`)
    records.push({ ...f, ...result, actual })
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
  for (const limit of [2000, 4000]) {
    const state = { ...long, prompt: long.prompt.slice(0, limit) }
    await ask(socket, state, questions)
    const samples = []
    for (let i = 0; i < 5; i++) samples.push(await ask(socket, state, questions))
    const row = { limit, p50: percentile(samples.map(r => r.ms), .5), p95: percentile(samples.map(r => r.ms), .95),
      actual: decide(samples[0].answers, samples[0].ms, config), answers: samples[0].answers }
    benchmarks.push(row)
    console.log(`Long prompt ${limit}:`, JSON.stringify({ ...row, answers: undefined }))
  }
  mkdirSync('.scratch', { recursive: true })
  writeFileSync('.scratch/s1-eval-results.json', JSON.stringify({ timestamp: new Date().toISOString(), node: process.version, config, summary, latency, records, benchmarks }, null, 2) + '\n', { mode: 0o600 })
  chmodSync('.scratch/s1-eval-results.json', 0o600)
  console.log('Raw answers/config/measurements: .scratch/s1-eval-results.json (nearest-rank p50/p95; no Parent Ceiling).')
}

main().catch(error => { console.error(`Eval failed: ${error.message}. Start S1 with /s1-setup or pass its socket.`); process.exitCode = 1 })
