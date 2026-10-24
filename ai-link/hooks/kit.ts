// Engine stand-ins shared by the tests: what sits beneath the plugin in a session.
export const USAGE = {
  startedAt: 0,
  context: { percent: 42, tokens: 84000, window: 1000000 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 2 },
    { kind: 'seven_day', percentUsed: 80 },
  ],
  cost: { usd: 0.7 },
}

export const stand = (
  on: any,
  sent: any[],
  store: Map<string, unknown>,
  delivered = true,
  opened: string[] = [],
  cwd = '/work/me',
) => {
  on('session.start', () => ({ cwd: '/work/me' }))
  on('session.id', () => ({ value: 'aaaa1111-0000' }))
  on('session.cwd', () => ({ value: cwd }))
  on('clock.now', () => ({ value: 3600000 }))
  on('command.register', () => ({ value: {} }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('session.receive', () => ({ consumed: 'no' }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  on('session.usage', () => ({ value: USAGE }))
  on('ui.open', (_$: any, e: any) => {
    opened.push(e.id)
    return { value: {} }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.get', (_$: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_$: any, e: any) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_$: any, e: any) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('session.send', (_$: any, e: any) => {
    sent.push(e)
    return delivered ? { isDelivered: true } : { isDelivered: false, reason: 'not running' }
  })
}
