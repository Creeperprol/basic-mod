import { expect, test } from 'claude-code/testing'

import { stand } from './kit'

const PANE = { plugin: 'ai-link', component: 'Pane', requestId: 'usage-bar', props: { bodyColumns: 30 } } as const

test('auto-opens the pane at session start by default', async ($, on) => {
  const opened: string[] = []
  stand(on, [], new Map(), true, opened)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
  expect(opened).toContain('usage-bar')
})

test('does not auto-open when autoOpen is off', { options: { autoOpen: false } }, async ($, on) => {
  const opened: string[] = []
  stand(on, [], new Map(), true, opened)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
  expect(opened).not.toContain('usage-bar')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`pane draws the meters and buttons on ${surface}`, async ($, on) => {
    stand(on, [], new Map())
    await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
    const ui = await $.ui.mount({ ...PANE, surface } as any)
    expect(await ui.find({ text: 'CONTEXT' })).toBeDefined()
    expect(await ui.find({ text: '42%' })).toBeDefined()
    expect(await ui.find({ text: 'WEEKLY' })).toBeDefined()
    expect(await ui.find({ text: '$0.70' })).toBeDefined()
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(4)
  })
}

test('hide breakdown button toggles its label', async ($, on) => {
  stand(on, [], new Map())
  await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  expect(await ui.find({ key: 'where' })).toBeDefined()
  await ui.press({ key: 'where' } as any)
  expect(await ui.find({ text: 'Show breakdown' })).toBeDefined()
})

test('pane shows the session name from the prompt', async ($, on) => {
  stand(on, [], new Map())
  on('classic.UserPromptSubmit', () => ({}))
  await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
  await $.classic.UserPromptSubmit({ prompt: 'hi', session_title: 'mod' } as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  expect(await ui.find({ text: 'mod' })).toBeDefined()
})

test('pane shows the reasoning effort from the prompt', async ($, on) => {
  stand(on, [], new Map())
  on('classic.UserPromptSubmit', () => ({}))
  await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  expect(await ui.find({ text: 'high' })).toBeUndefined()
  await $.classic.UserPromptSubmit({ prompt: 'hi', effort: { level: 'high' } } as any)
  expect(await ui.find({ text: 'high' })).toBeDefined()
})

test('the first prompt opens the usage pane again so a narrow terminal seats it', async ($, on) => {
  const opened: string[] = []
  stand(on, [], new Map(), true, opened)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
  const atStart = opened.filter(id => id === 'usage-bar').length
  await $.prompt.submit({ text: 'hi' } as any)
  await $.prompt.submit({ text: 'again' } as any)
  expect(opened.filter(id => id === 'usage-bar').length).toBe(atStart + 1)
})

test('the first prompt does not open the usage pane when auto open is off', { options: { autoOpen: false } }, async ($, on) => {
  const opened: string[] = []
  stand(on, [], new Map(), true, opened)
  await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
  await $.prompt.submit({ text: 'hi' } as any)
  expect(opened).not.toContain('usage-bar')
})
