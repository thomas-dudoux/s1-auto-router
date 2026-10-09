import type { Register } from 'claude-code'

// Ticket 01 probe: logs what a Spawn looks like to the debug log. Replaced by the router in ticket 04.
export const register: Register = (on) => {
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    $.ui.log(`s1-probe tool.call ${JSON.stringify(e)}`, { to: 'debug' })
    return next(e)
  })
  on('agent.spawn', async ($, e, next) => {
    $.ui.log(`s1-probe agent.spawn ${JSON.stringify(e)}`, { to: 'debug' })
    return next(e)
  })
  on('turn.step', async function* ($, e, next) {
    $.ui.log(`s1-probe turn.step ${JSON.stringify({ agentId: e.agentId, model: e.model, effort: e.effort })}`, { to: 'debug' })
    return yield* next(e)
  })
}
