import { expect, mock, test } from 'claude-code/testing'

const NOW = 1_000_000
// A crew configured the way the plugin's settings name one.
const CREW = { options: { supervisor: 'Supervisor', members: 'Mercurius, Venus, Terra, Mars, Saturnus, Uranus, Neptunus, Pluto, Jupiter', owner: 'Raf' } }
const beat = (name: string, state: string, beatAt: number, lastLine = '', progress: unknown = null) => JSON.stringify({
  sessionId: `id-${name}`, name, state, repo: 'macula-io/macula', model: 'claude-opus-5-5',
  turns: 3, contextPercent: 42, costUsd: 1.5, fiveHourPercent: 30, lastTool: '',
  lastLine, progress, startedAt: 0, beatAt,
})
const FILES: Record<string, string> = {
  'venus.json': beat('Venus', 'needs-you', NOW - 5_000, 'Push 3 commits to macula-rust?', { task: 'macula-php 0.8.0', step: 3, of: 7, source: 'report', at: NOW }),
  'terra.json': beat('Terra', 'idle', NOW - 600_000),
}

test('the pane lists every planet that checked in, stale ones offline', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home/test' })
  on('fs.exists', () => ({ value: true }))
  on('fs.list', () => ({ value: Object.keys(FILES).map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }))
  on('fs.read', (_$, e) => ({ value: FILES[e.path.split('/').at(-1) ?? ''] ?? '' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  await $.command.run({ command: 'crew', args: '' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'crew', surface, component: 'Pane', requestId: 'crew',
      props: { title: 'Crew', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
    })
    expect(await ui.find({ text: /1\/2 online/ })).toBeDefined()
    expect(await ui.find({ text: /Push 3 commits/ })).toBeDefined()
    expect(await ui.find({ text: /^offline/ })).toBeDefined()
    expect(await ui.find({ text: /3\/7/ })).toBeDefined()
    expect(await ui.find({ text: /macula-php 0\.8\.0/ })).toBeDefined()
  }
})

test('report_progress answers the model and records the step', async ($, on) => {
  const written: string[] = []
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home/test' })
  on('fs.exists', () => ({ value: false }))
  on('fs.write', (_$, e) => { written.push(e.text); return { value: undefined } })
  on('session.id', () => ({ value: 'id-venus' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent: 10 }, rateLimits: [] } }))
  on('session.repo', () => ({ value: null }))
  on('session.cwd', () => ({ value: '/w' }))
  on('session.root', () => ({ value: '/w' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.turns', () => ({ value: 1 }))
  on('session.messages', () => ({ value: [] }))
  on('store.get', () => ({ value: 'Venus' }))

  const ran = await $.tool.call({ tool: 'mcp__crew__report_progress', task: 'macula-php 0.8.0', step: 2, of: 5 } as never)

  expect(ran.text ?? String(ran.result)).toContain('2/5')
  const last = JSON.parse(written.at(-1) ?? '{}')
  expect(last.name).toBe('Venus')
  expect(last.progress).toMatchObject({ task: 'macula-php 0.8.0', step: 2, of: 5, source: 'report' })
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sessionMocks = (on: any, store: Map<string, unknown>, onWrite: (text: string) => void = () => {}) => {
  mock.env(on, { HOME: '/home/test' })
  on('fs.exists', () => ({ value: false }))
  on('fs.write', (_$: unknown, e: { text: string }) => { onWrite(e.text); return { value: undefined } })
  on('session.id', () => ({ value: 'id-fovea' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent: 55 }, rateLimits: [] } }))
  on('session.repo', () => ({ value: null }))
  on('session.cwd', () => ({ value: '/w' }))
  on('session.root', () => ({ value: '/w' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.turns', () => ({ value: 1 }))
  on('session.messages', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '2026-10-05\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('store.get', (_$: unknown, e: { key: string }) => ({ value: store.get(e.key) }))
  on('store.set', (_$: unknown, e: { key: string; value: unknown }) => { store.set(e.key, e.value); return { value: undefined } })
  on('store.delete', (_$: unknown, e: { key: string }) => { store.delete(e.key); return { value: undefined } })
}

test('crew-refresh now: handover, confirmation, clear, resume', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-fovea', 'FoveaMan']])
  const prompts: string[] = []
  const commands: string[] = []
  const clock = mock.clock(on, { now: NOW })
  sessionMocks(on, store)
  on('fs.stat', () => ({ value: { kind: 'file', size: 10, mtimeMs: Date.now() + 60_000, isLink: false } }))
  on('prompt.submit', (_$, e) => { prompts.push(e.text); return { text: e.text } })
  on('command.run', { command: 'clear' }, () => { commands.push('clear'); return { text: '' } })
  on('turn.complete', () => ({ text: '' }))

  await $.command.run({ command: 'crew-refresh', args: 'now' } as never)
  await clock.advance(600)
  expect(prompts[0]).toContain('HANDOVER_2026-10-05_FoveaMan.md')

  await $.turn.complete({ answer: 'Written.\nCREW-HANDOVER-WRITTEN', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)
  await clock.advance(600)

  expect(commands).toEqual(['clear'])
  expect(prompts[1]).toContain('You are FoveaMan')
  expect(store.get('refreshed:FoveaMan')).toBeDefined()
})

test('a declined refresh clears nothing', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-fovea', 'FoveaMan']])
  const commands: string[] = []
  const clock = mock.clock(on, { now: NOW })
  sessionMocks(on, store)
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('command.run', { command: 'clear' }, () => { commands.push('clear'); return { text: '' } })
  on('turn.complete', () => ({ text: '' }))

  await $.command.run({ command: 'crew-refresh', args: 'now' } as never)
  await clock.advance(600)
  await $.turn.complete({ answer: 'CREW-REFRESH-DECLINED holding an approved range', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)
  await clock.advance(600)

  expect(commands).toEqual([])
})

test('auto mode refreshes an idle Supervisor before its prompt cache lapses, not sooner', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-fovea', 'Supervisor'], ['refresh:Supervisor', 'auto']])
  const prompts: string[] = []
  const clock = mock.clock(on, { now: NOW })
  sessionMocks(on, store)
  on('prompt.submit', (_$, e) => { prompts.push(e.text); return { text: e.text } })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('command.run', { command: 'crew' }, () => ({ text: '' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.list', () => ({ value: [] }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }) as never)
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__crew__${e.name}` } }) as never)
  on('session.start', () => ({ cwd: '/w' }) as never)

  await $.session.start({ source: 'startup', cwd: '/w' } as never)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)

  await clock.advance(40 * 60_000)
  expect(prompts).toEqual([])

  await clock.advance(12 * 60_000)
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('HANDOVER_2026-10-05_Supervisor.md')
})

// Every beat the session writes, parsed, oldest first.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const beatsWritten = (on: any, store: Map<string, unknown>) => {
  const written: { state: string; lastLine: string; waitingOn?: string }[] = []
  sessionMocks(on, store, text => written.push(JSON.parse(text)))
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))

  return written
}
const answer = (text: string, turnId = 't1') => ({ answer: text, durationMs: 1, isAborted: false, turnId, reason: 'answer' }) as never

test('a question menu needs Raf while it is open, and the turn is working again once answered', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-fovea', 'Uranus']])
  mock.clock(on, { now: NOW })
  const written = beatsWritten(on, store)
  let whileOpen = ''
  on('tool.call', { tool: 'AskUserQuestion' }, () => { whileOpen = written.at(-1)?.state ?? ''; return { result: { answers: {} } } as never })

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)

  expect(whileOpen).toBe('needs-you')
  expect(written.at(-1)?.state).toBe('working')
})

test('a permission dialog needs Raf until the call it stood on resolves', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-fovea', 'Uranus']])
  mock.clock(on, { now: NOW })
  const written = beatsWritten(on, store)
  let whileOpen = ''
  // No settings hook decides, so the dialog shows; it opens while the call is underway.
  on('classic.PermissionRequest', () => ({}) as never)
  on('tool.call', { tool: 'Bash' }, async () => {
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'git push' } } as never)
    whileOpen = `${written.at(-1)?.state} ${written.at(-1)?.lastLine}`
    return { result: { stdout: '', stderr: '' } } as never
  })

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'git push' } as never)

  expect(whileOpen).toBe('needs-you permission for Bash')
  expect(written.at(-1)?.state).toBe('working')
})

test('a closing question needs Raf until the next turn starts', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-fovea', 'Uranus']])
  mock.clock(on, { now: NOW })
  const written = beatsWritten(on, store)

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete(answer('Push 3 commits?'))
  expect(written.at(-1)?.state).toBe('needs-you')

  await $.turn.start({ text: 'yes', turnId: 't2' })
  expect(written.at(-1)?.state).toBe('working')
})

test('an unfinished reported task leaves the session waiting on it, a finished one idle', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-fovea', 'Uranus']])
  mock.clock(on, { now: NOW })
  const written = beatsWritten(on, store)
  on('prompt.submit', (_$, e) => ({ text: e.text }))

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'mcp__crew__report_progress', task: 'crew states', step: 1, of: 4 } as never)
  await $.turn.complete(answer('Sent the subagent off.'))
  expect(written.at(-1)).toMatchObject({ state: 'waiting', waitingOn: 'crew states (1/4)' })

  await $.turn.start({ text: 'go on', turnId: 't2' })
  await $.tool.call({ tool: 'mcp__crew__report_progress', task: 'crew states', step: 4, of: 4 } as never)
  await $.turn.complete(answer('Done.', 't2'))
  expect(written.at(-1)).toMatchObject({ state: 'idle', waitingOn: '' })
})

test('background work and wake-ups from the Stop hook keep the session waiting, whichever lands first', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-fovea', 'Uranus']])
  mock.clock(on, { now: NOW })
  const written = beatsWritten(on, store)
  on('classic.Stop', () => ({}) as never)
  const stop = { stop_hook_active: false, background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'cargo test on the lab box' }], session_crons: [] }

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete(answer('Started the suite.'))
  await $.classic.Stop(stop as never)
  expect(written.at(-1)).toMatchObject({ state: 'waiting', waitingOn: 'shell: cargo test on the lab box' })

  await $.turn.start({ text: 'again', turnId: 't2' })
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [{ id: 'c1', schedule: '* * * * *', recurring: false, prompt: 'check' }] } as never)
  await $.turn.complete(answer('Checking back later.', 't2'))
  expect(written.at(-1)).toMatchObject({ state: 'waiting', waitingOn: 'a scheduled wake-up' })

  await $.turn.start({ text: 'again', turnId: 't3' })
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [] } as never)
  await $.turn.complete(answer('All done.', 't3'))
  expect(written.at(-1)?.state).toBe('idle')
})

test('a finished task shows a refresh due only when that refresh will run', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-fovea', 'Uranus']])
  mock.clock(on, { now: NOW })
  const written = beatsWritten(on, store) as unknown as { refresh: { phase: string } | null }[]
  const finished = { tool: 'mcp__crew__report_progress', task: 'crew states', step: 4, of: 4 } as never

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call(finished)
  expect(written.at(-1)?.refresh).toBeNull()

  store.set('refresh:Uranus', 60)
  await $.tool.call(finished)
  expect(written.at(-1)?.refresh?.phase).toBe('none')

  store.set('refresh:Uranus', 40)
  await $.tool.call(finished)
  expect(written.at(-1)?.refresh?.phase).toBe('due')
})

test('a background agent that ends while the session is idle leaves the row idle without a new turn', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-fovea', 'Uranus']])
  const clock = mock.clock(on, { now: NOW })
  const written = beatsWritten(on, store)
  const agents = [{ id: 'a1', description: 'review the diff', type: 'Explore', status: 'running' }]
  on('agent.list', () => ({ value: agents }) as never)
  on('classic.Stop', () => ({}) as never)
  on('fs.list', () => ({ value: [] }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }) as never)
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__crew__${e.name}` } }) as never)
  on('session.start', () => ({ cwd: '/w' }) as never)
  const review = { id: 'a1', type: 'subagent', status: 'running', description: 'review the diff', agent_type: 'Explore' }

  await $.session.start({ source: 'startup', cwd: '/w' } as never)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete(answer('Review running.'))
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [review], session_crons: [] } as never)
  await clock.advance(20_000)
  expect(written.at(-1)).toMatchObject({ state: 'waiting', waitingOn: 'Explore: review the diff' })

  agents[0].status = 'completed'
  await clock.advance(20_000)
  expect(written.at(-1)).toMatchObject({ state: 'idle', waitingOn: '' })
})

test('a subagent that stops refreshes the background list: a shell that ended leaves it', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-fovea', 'Uranus']])
  mock.clock(on, { now: NOW })
  const written = beatsWritten(on, store)
  on('classic.Stop', () => ({}) as never)
  on('classic.SubagentStop', () => ({}) as never)
  const suite = { id: 'b1', type: 'shell', status: 'running', description: 'cargo test' }

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete(answer('Started the suite.'))
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [suite], session_crons: [] } as never)
  expect(written.at(-1)).toMatchObject({ state: 'waiting', waitingOn: 'shell: cargo test' })

  await $.classic.SubagentStop({ stop_hook_active: false, agent_id: 'a1', agent_transcript_path: '/t', agent_type: 'Explore', background_tasks: [], session_crons: [] } as never)
  expect(written.at(-1)).toMatchObject({ state: 'idle', waitingOn: '' })
})

test('a beat from a session on the older mod still draws: asking shows as needs-you', async ($, on) => {
  const files: Record<string, string> = { 'mars.json': beat('Mars', 'asking', NOW - 1_000, 'Merge it?') }
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home/test' })
  on('fs.exists', () => ({ value: true }))
  on('fs.list', () => ({ value: Object.keys(files).map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }))
  on('fs.read', (_$, e) => ({ value: files[e.path.split('/').at(-1) ?? ''] ?? '' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  await $.command.run({ command: 'crew', args: '' } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'crew', surface, component: 'Pane', requestId: 'crew',
      props: { title: 'Crew', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
    })
    expect(await ui.find({ text: /^needs-you/ })).toBeDefined()
  }
})

test('a session that ended in this process writes no more beats until a turn runs in it again', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-fovea', 'FoveaMan']])
  const written: string[] = []
  const clock = mock.clock(on, { now: NOW })
  sessionMocks(on, store, text => written.push(text))
  on('fs.list', () => ({ value: [] }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }) as never)
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__crew__${e.name}` } }) as never)
  on('session.start', () => ({ cwd: '/w' }) as never)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }) as never)

  await $.session.start({ source: 'startup', cwd: '/w' } as never)
  await $.session.end({ reason: 'resume', sessionId: 'id-fovea', resume: {} } as never)
  expect(JSON.parse(written.at(-1) ?? '{}').state).toBe('offline')

  const atEnd = written.length
  await clock.advance(60_000)
  expect(written.length).toBe(atEnd)

  await $.turn.start({ text: 'back', turnId: 't2' })
  expect(JSON.parse(written.at(-1) ?? '{}').state).toBe('working')
})

const SWEEP_NOW = 10_000_000
const SWEEP_FILES: Record<string, string> = {
  'fresh.json': beat('Venus', 'idle', SWEEP_NOW - 5_000),
  'just-off.json': beat('Terra', 'idle', SWEEP_NOW - 600_000),
  'ancient.json': beat('Pluto', 'idle', SWEEP_NOW - 7_200_000),
}

test('a beat file hours stale is swept off disk, one that just went offline still draws', async ($, on) => {
  const argvs: string[][] = []
  mock.clock(on, { now: SWEEP_NOW })
  mock.env(on, { HOME: '/home/test' })
  on('fs.exists', () => ({ value: true }))
  on('fs.list', () => ({ value: Object.keys(SWEEP_FILES).map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }))
  on('fs.read', (_$, e) => ({ value: SWEEP_FILES[e.path.split('/').at(-1) ?? ''] ?? '' }))
  on('process.run', (_$, e) => {
    argvs.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))

  await $.command.run({ command: 'crew', args: '' } as never)

  const ui = await $.ui.mount({
    plugin: 'crew', surface: 'terminal', component: 'Pane', requestId: 'crew',
    props: { title: 'Crew', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  expect(await ui.find({ text: /Venus/ })).toBeDefined()
  expect(await ui.find({ text: /Terra/ })).toBeDefined()
  expect(await ui.find({ text: /Pluto/ })).toBeUndefined()

  const swept = argvs.flat()
  expect(swept).toContain('/home/test/.claude/crew/ancient.json')
  expect(swept).not.toContain('/home/test/.claude/crew/just-off.json')
  expect(swept).not.toContain('/home/test/.claude/crew/fresh.json')
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const titledSession = (on: any, title: string, env: Record<string, string>, written: string[]) => {
  mock.env(on, { HOME: '/home/test', ...env })
  on('fs.exists', () => ({ value: true }))
  on('fs.list', () => ({ value: [] }))
  on('fs.write', (_$: unknown, e: { text: string }) => { written.push(e.text); return { value: undefined } })
  on('process.run', () => ({ value: { exitCode: 0, stdout: `"customTitle":"${title}"\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.id', () => ({ value: 'id-resumed' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent: 10 }, rateLimits: [] } }))
  on('session.repo', () => ({ value: null }))
  on('session.cwd', () => ({ value: '/w' }))
  on('session.root', () => ({ value: '/w' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.turns', () => ({ value: 1 }))
  on('session.messages', () => ({ value: [] }))
  on('store.get', () => ({ value: undefined }))
}

const nameOf = (written: string[]) => JSON.parse(written.at(-1) ?? '{}').name

test('a resumed session the terminal titled "Mars (2)" beats as Mars, not as a new member', CREW, async ($, on) => {
  const written: string[] = []
  mock.clock(on, { now: NOW })
  titledSession(on, 'Mars (2)', {}, written)

  await $.tool.call({ tool: 'mcp__crew__report_progress', task: 'station roll', step: 1, of: 3 } as never)

  expect(nameOf(written)).toBe('Mars')
})

test('a title that is nobody on the roster yields to CREW_NAME', CREW, async ($, on) => {
  const written: string[] = []
  mock.clock(on, { now: NOW })
  titledSession(on, 'help', { CREW_NAME: 'Jupiter' }, written)

  await $.tool.call({ tool: 'mcp__crew__report_progress', task: 'fovea kx', step: 2, of: 4 } as never)

  expect(nameOf(written)).toBe('Jupiter')
})

// A crew session with a context level the test controls, every prompt it is sent and every file it writes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const crewSession = (on: any, store: Map<string, unknown>, context: { percent: number }) => {
  const prompts: string[] = []
  const files = new Map<string, string>()
  mock.env(on, { HOME: '/home/test' })
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: files.has(e.path) }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', (_$: unknown, e: { path: string; text: string }) => { files.set(e.path, e.text); return { value: undefined } })
  on('fs.list', () => ({ value: [] }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 10, mtimeMs: Date.now() + 60_000, isLink: false } }))
  on('session.id', () => ({ value: 'id-crew' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent: context.percent }, rateLimits: [] } }))
  on('session.repo', () => ({ value: null }))
  on('session.cwd', () => ({ value: '/w' }))
  on('session.root', () => ({ value: '/w' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.turns', () => ({ value: 1 }))
  on('session.messages', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '2026-10-06\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('store.get', (_$: unknown, e: { key: string }) => ({ value: store.get(e.key) }))
  on('store.set', (_$: unknown, e: { key: string; value: unknown }) => { store.set(e.key, e.value); return { value: undefined } })
  on('store.delete', (_$: unknown, e: { key: string }) => { store.delete(e.key); return { value: undefined } })
  on('prompt.submit', (_$: unknown, e: { text: string }) => { prompts.push(e.text); return { text: e.text } })
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('command.run', { command: 'clear' }, () => ({ text: '' }))
  on('command.register', (_$: unknown, e: { name: string }) => ({ value: { command: e.name } }) as never)
  on('tool.register', (_$: unknown, e: { name: string }) => ({ value: { tool: `mcp__crew__${e.name}` } }) as never)
  on('session.start', () => ({ cwd: '/w' }) as never)

  return { prompts, files }
}
const CARD = 'card-0123456789abcdef0123456789abcdef'
const claimNext = { tool: 'mcp__macula__mesh_call', procedure: 'mcl-kanban/claim_next_card', args: {} } as never
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const board = (on: any, reply: unknown) => {
  const reached: string[] = []
  on('tool.call', { tool: 'mcp__macula__mesh_call' }, (_$: unknown, e: { procedure: string }) => {
    reached.push(e.procedure)
    return { result: { content: [{ type: 'text', text: JSON.stringify(reply) }] } } as never
  })
  return reached
}

test('above the claim limit a member cannot start a card: the claim is refused and a handover follows', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-crew', 'Mars']])
  const clock = mock.clock(on, { now: NOW })
  const { prompts } = crewSession(on, store, { percent: 55 })
  const reached = board(on, { card: { card_id: CARD } })

  await $.turn.start({ text: 'go', turnId: 't1' })
  const ran = await $.tool.call(claimNext)
  expect(String(ran.deny)).toContain('55%')
  expect(reached).toEqual([])

  await $.turn.complete(answer('Not claiming: handing over first.'))
  await clock.advance(600)
  expect(prompts[0]).toContain('HANDOVER_2026-10-06_Mars.md')
})

test('below the claim limit the claim goes through', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-crew', 'Mars']])
  mock.clock(on, { now: NOW })
  crewSession(on, store, { percent: 30 })
  const reached = board(on, { card: { card_id: CARD } })

  await $.turn.start({ text: 'go', turnId: 't1' })
  const ran = await $.tool.call(claimNext)
  expect(ran.deny).toBeUndefined()
  expect(reached).toEqual(['mcl-kanban/claim_next_card'])
})

test('at the handover limit a finished turn starts a handover that asks for a safe point first', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-crew', 'Mars']])
  const clock = mock.clock(on, { now: NOW })
  const { prompts } = crewSession(on, store, { percent: 72 })

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete(answer('Tests pass, writing the fix next.'))
  await clock.advance(600)
  expect(prompts[0]).toContain('safe point')
  expect(prompts[0]).toContain('HANDOVER_2026-10-06_Mars.md')
})

test('an idle member with nothing in hand is woken to work the board', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-crew', 'Mars']])
  const clock = mock.clock(on, { now: NOW })
  const { prompts } = crewSession(on, store, { percent: 20 })

  await $.session.start({ source: 'startup', cwd: '/w' } as never)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete(answer('Done.'))
  await clock.advance(60_000)
  expect(prompts).toEqual([])

  await clock.advance(2 * 60_000)
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('work the board')
})

test('the Supervisor is never woken', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-crew', 'Supervisor']])
  const clock = mock.clock(on, { now: NOW })
  const { prompts } = crewSession(on, store, { percent: 20 })

  await $.session.start({ source: 'startup', cwd: '/w' } as never)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete(answer('Done.'))
  await clock.advance(10 * 60_000)
  expect(prompts).toEqual([])
})

test('a parked member is never woken, not even into a handover, until it is unparked', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-crew', 'Mars']])
  const clock = mock.clock(on, { now: NOW })
  const context = { percent: 20 }
  const { prompts, files } = crewSession(on, store, context)

  await $.session.start({ source: 'startup', cwd: '/w' } as never)
  const parked = await $.command.run({ command: 'crew-park', args: '' } as never)
  expect(parked.text).toContain('Mars is parked')
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete(answer('Stopped, as told.'))
  await clock.advance(10 * 60_000)
  context.percent = 60
  await clock.advance(10 * 60_000)
  expect(prompts).toEqual([])
  expect(JSON.parse(files.get('/home/test/.claude/crew/id-crew.json') ?? '{}').isParked).toBe(true)

  context.percent = 20
  await $.command.run({ command: 'crew-park', args: 'off' } as never)
  await clock.advance(2 * 60_000)
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('work the board')
  expect(prompts[0]).toContain('call crew_park with parked 1')
})

test('a member told to stop parks itself with crew_park and is never woken, until it unparks', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-crew', 'Mars']])
  const clock = mock.clock(on, { now: NOW })
  const { prompts, files } = crewSession(on, store, { percent: 20 })

  await $.session.start({ source: 'startup', cwd: '/w' } as never)
  await $.turn.start({ text: 'Stop after this push.', turnId: 't1' })
  const ran = await $.tool.call({ tool: 'mcp__crew__crew_park', parked: 1, reason: 'the Supervisor said stop' } as never)
  expect(String(ran.result)).toContain('parked')
  await $.turn.complete(answer('Parked, as told.'))
  await clock.advance(20 * 60_000)
  expect(prompts).toEqual([])
  expect(store.get('park:Mars')).toBe(1)
  expect(JSON.parse(files.get('/home/test/.claude/crew/id-crew.json') ?? '{}').isParked).toBe(true)

  await $.turn.start({ text: 'Resume.', turnId: 't2' })
  await $.tool.call({ tool: 'mcp__crew__crew_park', parked: 0, reason: 'told to resume' } as never)
  await $.turn.complete(answer('Unparked.', 't2'))
  await clock.advance(3 * 60_000)
  expect(store.has('park:Mars')).toBe(false)
  expect(prompts.length).toBe(1)
})

test('a row on the dashboard shows its member parked', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home/test' })
  const parked = JSON.stringify({ ...JSON.parse(beat('Mars', 'idle', NOW - 1_000)), isParked: true })
  on('fs.exists', () => ({ value: true }))
  on('fs.list', () => ({ value: [{ name: 'mars.json', kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false }] }))
  on('fs.read', () => ({ value: parked }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  await $.command.run({ command: 'crew', args: '' } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'crew', surface, component: 'Pane', requestId: 'crew',
      props: { title: 'Crew', isFocused: false, bodyColumns: 140, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
    })
    expect(await ui.find({ text: /parked/ })).toBeDefined()
  }
})

test('the board rules tell members to name what they start and stop only that', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-crew', 'Mars']])
  mock.clock(on, { now: NOW })
  crewSession(on, store, { percent: 30 })
  on('prompt.compose', () => ({ sections: [] }) as never)

  const composed = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
  const rules = composed.sections.find((section: { id: string }) => section.id === 'crew:board')
  expect(rules?.text).toContain('after yourself')
  expect(rules?.text).toContain('never stop by image or filter')
  expect(rules?.text).toContain('call crew_park')
})

test('an idle member above the claim limit is woken into a handover, not a card', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-crew', 'Mars']])
  const clock = mock.clock(on, { now: NOW })
  const { prompts } = crewSession(on, store, { percent: 60 })

  await $.session.start({ source: 'startup', cwd: '/w' } as never)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete(answer('Done.'))
  await clock.advance(4 * 60_000)
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('HANDOVER_2026-10-06_Mars.md')
})

test('after the board answers board_empty, nobody is woken for half an hour', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-crew', 'Mars']])
  const clock = mock.clock(on, { now: NOW })
  const { prompts } = crewSession(on, store, { percent: 20 })
  board(on, { reason: 'board_empty' })

  await $.session.start({ source: 'startup', cwd: '/w' } as never)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call(claimNext)
  await $.turn.complete(answer('Board is empty.'))
  await clock.advance(20 * 60_000)
  expect(prompts).toEqual([])

  await clock.advance(12 * 60_000)
  expect(prompts.length).toBe(1)
})

test('after a refresh a member works the board instead of waiting for the Supervisor', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-crew', 'Mars']])
  const clock = mock.clock(on, { now: NOW })
  const { prompts } = crewSession(on, store, { percent: 30 })

  await $.command.run({ command: 'crew-refresh', args: 'now' } as never)
  await clock.advance(600)
  await $.turn.complete(answer('Written.\nCREW-HANDOVER-WRITTEN'))
  await clock.advance(600)

  expect(prompts[1]).toContain('work the board')
  expect(prompts[1]).not.toContain('wait for')
})

test('the board rules are part of every session prompt', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-crew', 'Mars']])
  mock.clock(on, { now: NOW })
  crewSession(on, store, { percent: 30 })
  on('prompt.compose', () => ({ sections: [] }) as never)

  const composed = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
  const rules = composed.sections.find((section: { id: string }) => section.id === 'crew:board')
  expect(rules?.text).toContain('claim_next_card')
  expect(rules?.text).toContain('50%')
})

test('each card logs the context it used, from claim to finish', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-crew', 'Mars']])
  mock.clock(on, { now: NOW })
  const context = { percent: 20 }
  const { files } = crewSession(on, store, context)
  board(on, { card: { card_id: CARD } })

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call(claimNext)
  context.percent = 35
  await $.tool.call({ tool: 'mcp__macula__mesh_call', procedure: 'mcl-kanban/finish_card', args: { card_id: CARD, result: 'done' } } as never)

  expect(files.get('/home/test/.claude/crew/card-usage.tsv')).toContain(`Mars\t${CARD}\t20\t35`)
})

// Package mode: a member keeps its context across the cards of one work package and refreshes
// when the board hands it a card from another package, unless its context is still small.
const claimed = (card: string, pkg: string) => ({ card: { card_id: card, issue_ref: 'macula-io/macula#1', work_package: pkg } })
const CARD_B = 'card-ffffffffffffffffffffffffffffffff'

test('/crew-refresh package turns package mode on for this member, all for every member but the Supervisor', CREW, async ($, on) => {
  const store = new Map<string, unknown>([['name:id-crew', 'Mars']])
  mock.clock(on, { now: NOW })
  crewSession(on, store, { percent: 30 })

  const one = await $.command.run({ command: 'crew-refresh', args: 'package' } as never)
  expect(one.text).toContain('package')
  expect(store.get('refresh:Mars')).toBe('package')

  await $.command.run({ command: 'crew-refresh', args: 'package all' } as never)
  expect(store.get('refresh:Venus')).toBe('package')
  expect(store.get('refresh:Pluto')).toBe('package')
  expect(store.has('refresh:Supervisor')).toBe(false)
})

test('in package mode a card from another work package hands over before it is started', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-crew', 'Mars'], ['refresh:Mars', 'package'], ['package:Mars', 'macula-io/macula#70']])
  const clock = mock.clock(on, { now: NOW })
  const { prompts } = crewSession(on, store, { percent: 35 })
  board(on, claimed(CARD, 'macula-io/macula-realm#40'))

  await $.turn.start({ text: 'go', turnId: 't1' })
  const ran = await $.tool.call(claimNext)
  expect(JSON.stringify(ran.result)).toContain('do not start this card')
  await $.turn.complete(answer('Claimed.'))
  await clock.advance(600)

  expect(prompts.some(text => text.includes('handover'))).toBe(true)
  expect(store.get('package:Mars')).toBe('macula-io/macula-realm#40')
})

test('in package mode the next card of the same package keeps the session going', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-crew', 'Mars'], ['refresh:Mars', 'package'], ['package:Mars', 'macula-io/macula#70']])
  const clock = mock.clock(on, { now: NOW })
  const { prompts } = crewSession(on, store, { percent: 35 })
  board(on, claimed(CARD, 'macula-io/macula#70'))

  await $.turn.start({ text: 'go', turnId: 't1' })
  const ran = await $.tool.call(claimNext)
  await $.turn.complete(answer('Claimed.'))
  await clock.advance(600)

  expect(JSON.stringify(ran.result)).not.toContain('do not start this card')
  expect(prompts.some(text => text.includes('handover'))).toBe(false)
})

test('in package mode a new package with little context used is not worth a refresh', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-crew', 'Mars'], ['refresh:Mars', 'package'], ['package:Mars', 'macula-io/macula#70']])
  const clock = mock.clock(on, { now: NOW })
  const { prompts } = crewSession(on, store, { percent: 12 })
  board(on, claimed(CARD_B, 'macula-io/macula-realm#40'))

  await $.turn.start({ text: 'go', turnId: 't1' })
  const ran = await $.tool.call(claimNext)
  await $.turn.complete(answer('Claimed.'))
  await clock.advance(600)

  expect(JSON.stringify(ran.result)).not.toContain('do not start this card')
  expect(prompts.some(text => text.includes('handover'))).toBe(false)
  expect(store.get('package:Mars')).toBe('macula-io/macula-realm#40')
})

test('without package mode a new package changes nothing', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-crew', 'Mars'], ['package:Mars', 'macula-io/macula#70']])
  const clock = mock.clock(on, { now: NOW })
  const { prompts } = crewSession(on, store, { percent: 35 })
  board(on, claimed(CARD, 'macula-io/macula-realm#40'))

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call(claimNext)
  await $.turn.complete(answer('Claimed.'))
  await clock.advance(600)

  expect(prompts.some(text => text.includes('handover'))).toBe(false)
})

test('the dashboard shows the card a member holds, from claim until it is finished', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-crew', 'Mars']])
  mock.clock(on, { now: NOW })
  const context = { percent: 20 }
  const { files } = crewSession(on, store, context)
  board(on, { card: { card_id: CARD, issue_ref: 'macula-io/macula#75', links: [{ to_card_id: 'card-ffffffffffffffffffffffffffffffff' }] } })
  const beat = () => JSON.parse(files.get('/home/test/.claude/crew/id-crew.json') ?? '{}')

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call(claimNext)
  expect(beat().card).toBe('macula-io/macula#75')

  await $.tool.call({ tool: 'mcp__macula__mesh_call', procedure: 'mcl-kanban/finish_card', args: { card_id: CARD, result: 'done' } } as never)
  expect(beat().card).toBe('')
})

test('a row on the dashboard names the card its member holds', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home/test' })
  const holding = JSON.stringify({ ...JSON.parse(beat('Mars', 'working', NOW - 1_000)), card: 'macula-io/macula#75', lastTool: 'Bash' })
  on('fs.exists', () => ({ value: true }))
  on('fs.list', () => ({ value: [{ name: 'mars.json', kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false }] }))
  on('fs.read', () => ({ value: holding }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  await $.command.run({ command: 'crew', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'crew', surface: 'terminal', component: 'Pane', requestId: 'crew',
    props: { title: 'Crew', isFocused: false, bodyColumns: 140, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  expect(await ui.find({ text: /macula-io\/macula#75/ })).toBeDefined()
})

// The board's goal procedures, reached through the macula MCP server's mesh_call (kanban#18).
const GOAL = { goal: 'A stranger can find an app on the mesh', packages: ['macula-io/macula#75'], by: 'Raf', at: Date.UTC(2026, 9, 6) }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const goalBoard = (on: any, held: { goal: unknown }) => {
  const calls: { procedure: string; args: Record<string, unknown> }[] = []
  on('mcp.call', (_$: unknown, e: { server: string; tool: string; args: { procedure: string; args: Record<string, unknown> } }) => {
    calls.push(e.args)
    if (e.args.procedure === 'mcl-kanban/adopt_goal') held.goal = { ...e.args.args, by: 'Supervisor', at: Date.UTC(2026, 9, 7) }
    const result = held.goal === null ? {} : { goal: held.goal }
    return { value: { content: [{ type: 'text', text: JSON.stringify({ result, duration_ms: 3 }) }], isError: false } }
  })
  return calls
}
const goalPane = async ($: { ui: { mount: (x: never) => Promise<{ find: (q: { text: RegExp }) => Promise<unknown> }> } }) =>
  $.ui.mount({
    plugin: 'crew', surface: 'terminal', component: 'Pane', requestId: 'crew',
    props: { title: 'Crew', isFocused: false, bodyColumns: 140, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  } as never)

test('/crew-goal shows the crew goal with its packages and the date it was set', async ($, on) => {
  mock.clock(on, { now: NOW })
  crewSession(on, new Map(), { percent: 20 })
  goalBoard(on, { goal: GOAL })

  const ran = await $.command.run({ command: 'crew-goal', args: '' } as never)

  expect(ran.text).toContain('A stranger can find an app on the mesh')
  expect(ran.text).toContain('macula-io/macula#75')
  expect(ran.text).toContain('2026-10-06')
})

test('/crew-goal with package refs and a sentence adopts the goal on the board', async ($, on) => {
  mock.clock(on, { now: NOW })
  crewSession(on, new Map(), { percent: 20 })
  const calls = goalBoard(on, { goal: GOAL })

  const ran = await $.command.run({ command: 'crew-goal', args: 'macula-io/macula#76 macula-services/mcl-kanban#4 Every account has its own identity keys' } as never)

  const adopt = calls.find(call => call.procedure === 'mcl-kanban/adopt_goal')
  expect(adopt?.args).toEqual({ goal: 'Every account has its own identity keys', packages: ['macula-io/macula#76', 'macula-services/mcl-kanban#4'] })
  expect(ran.text).toContain('Every account has its own identity keys')
  expect(ran.text).toContain('2026-10-07')
})

test('/crew-goal refuses a sentence without a package, or more than two packages, and adopts nothing', async ($, on) => {
  mock.clock(on, { now: NOW })
  crewSession(on, new Map(), { percent: 20 })
  const calls = goalBoard(on, { goal: GOAL })

  const bare = await $.command.run({ command: 'crew-goal', args: 'Ship everything' } as never)
  const three = await $.command.run({ command: 'crew-goal', args: 'a/b#1 a/b#2 a/b#3 Too much' } as never)

  expect(bare.text).toContain('Usage')
  expect(three.text).toContain('Usage')
  expect(calls.some(call => call.procedure === 'mcl-kanban/adopt_goal')).toBe(false)
})

test('the dashboard shows the goal and its date at the top, or how to set one', async ($, on) => {
  mock.clock(on, { now: NOW })
  crewSession(on, new Map(), { percent: 20 })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const held: { goal: unknown } = { goal: null }
  goalBoard(on, held)

  await $.command.run({ command: 'crew', args: '' } as never)
  const ui = await goalPane($ as never)
  expect(await ui.find({ text: /No crew goal/ })).toBeDefined()

  held.goal = GOAL
  await $.command.run({ command: 'crew', args: '' } as never)
  expect(await ui.find({ text: /A stranger can find an app on the mesh/ })).toBeDefined()
  expect(await ui.find({ text: /2026-10-06/ })).toBeDefined()
})

test('a board that cannot be reached leaves /crew-goal saying so, not a blank goal', async ($, on) => {
  mock.clock(on, { now: NOW })
  crewSession(on, new Map(), { percent: 20 })
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: 'mesh_call failed: no trusted provider (code=no_provider)' }], isError: true } }))

  const ran = await $.command.run({ command: 'crew-goal', args: '' } as never)

  expect(ran.text).toContain('no_provider')
})

test('with no members configured, any name is accepted and the prompts name the configured owner', { options: { owner: 'Ada' } }, async ($, on) => {
  const store = new Map<string, unknown>([['name:id-crew', 'Grace']])
  mock.clock(on, { now: NOW })
  crewSession(on, store, { percent: 10 })
  on('prompt.compose', () => ({ sections: [] }) as never)

  const composed = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
  const text = JSON.stringify(composed)
  expect(text).toContain("Ada's yes")
  expect(text).not.toContain('Raf')
})

// The board setting: mesh (default) reaches mcl-kanban through the macula MCP server, in the configured
// realm; off leaves the board out entirely. A board that cannot be reached is said once, loudly.
const REALM = 'ab'.repeat(32)

test('board off: no board rules in the prompt, no wake-ups to work it, /crew-goal says the board is off', { options: { board: 'off' } }, async ($, on) => {
  const store = new Map<string, unknown>([['name:id-crew', 'Mars']])
  mock.clock(on, { now: NOW })
  crewSession(on, store, { percent: 10 })
  on('prompt.compose', () => ({ sections: [] }) as never)

  const composed = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
  expect(JSON.stringify(composed)).not.toContain('claim_next_card')
  const goal = await $.command.run({ command: 'crew-goal', args: '' } as never)
  expect(goal.text).toContain('board is off')
})

test('board calls go to the configured realm', { options: { realm: REALM } }, async ($, on) => {
  mock.clock(on, { now: NOW })
  crewSession(on, new Map(), { percent: 20 })
  const seen: unknown[] = []
  on('mcp.call', (_$: unknown, e: { args: unknown }) => {
    seen.push(e.args)
    return { value: { content: [{ type: 'text', text: JSON.stringify({ result: {} }) }], isError: false } }
  })
  on('prompt.compose', () => ({ sections: [] }) as never)

  await $.command.run({ command: 'crew-goal', args: '' } as never)
  expect(seen[0]).toMatchObject({ procedure: 'mcl-kanban/get_goal', realm: REALM })
  const composed = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
  expect(JSON.stringify(composed)).toContain(REALM)
})

test('a board nobody serves is said on the dashboard and in the prompt, and nobody is woken to work it', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-crew', 'Mars']])
  mock.clock(on, { now: NOW })
  crewSession(on, store, { percent: 20 })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.compose', () => ({ sections: [] }) as never)
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: 'mesh_call failed: no trusted provider advertises the procedure (code=no_provider)' }], isError: true } }))

  await $.command.run({ command: 'crew', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'crew', surface: 'terminal', component: 'Pane', requestId: 'crew',
    props: { title: 'Crew', isFocused: false, bodyColumns: 140, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  } as never)
  expect(await ui.find({ text: /no board/ })).toBeDefined()
  const composed = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
  expect(JSON.stringify(composed)).toContain('no board')
})
