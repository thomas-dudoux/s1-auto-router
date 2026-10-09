import { test, expect } from 'claude-code/testing'

test('probe logs the Agent tool.call input to the debug log', async ($, on) => {
  const logs: { text: string; to?: string }[] = []
  on('ui.log', ($, e) => { logs.push({ text: e.text, to: e.to }); return { value: undefined } })
  on('tool.call', () => ({ result: 'ok' }) as any)
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', subagent_type: 'Explore', effort: 'low' } as any)
  expect(logs).toHaveLength(1)
  expect(logs[0].to).toBe('debug')
  const prefix = 's1-probe tool.call '
  expect(logs[0].text.startsWith(prefix)).toBe(true)
  expect(JSON.parse(logs[0].text.slice(prefix.length))).toMatchObject({ subagent_type: 'Explore', effort: 'low' })
})
