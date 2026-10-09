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
  // Only beat files reach onWrite: the ledger's JSON lines are not beats.
  on('fs.write', (_$: unknown, e: { path: string; text: string }) => { if (!e.path.includes('/ledger/')) onWrite(e.text); return { value: undefined } })
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

  agents[0]!.status = 'completed'
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
const crewSession = (on: any, store: Map<string, unknown>, context: { percent: number; rateLimits?: unknown[] }) => {
  const prompts: string[] = []
  const files = new Map<string, string>()
  // Every /model the session is switched with, as the command ran.
  const models: string[] = []
  mock.env(on, { HOME: '/home/test' })
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: files.has(e.path) }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', (_$: unknown, e: { path: string; text: string }) => { files.set(e.path, e.text); return { value: undefined } })
  // A directory lists the files this session holds under it.
  on('fs.list', (_$: unknown, e: { path: string }) => ({
    value: [...files.keys()].filter(path => path.startsWith(`${e.path}/`)).map(path => ({ name: path.slice(e.path.length + 1), kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })),
  }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 10, mtimeMs: Date.now() + 60_000, isLink: false } }))
  on('session.id', () => ({ value: 'id-crew' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent: context.percent }, rateLimits: context.rateLimits ?? [] } }))
  on('session.repo', () => ({ value: null }))
  on('session.cwd', () => ({ value: '/w' }))
  on('session.root', () => ({ value: '/w' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.turns', () => ({ value: 1 }))
  on('session.messages', () => ({ value: [] }))
  // `rm -f <paths>` removes files this session holds; anything else answers with today's date.
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    if (e.argv[0] === 'rm') e.argv.slice(2).forEach(path => files.delete(path))
    return { value: { exitCode: 0, stdout: '2026-10-06\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('store.get', (_$: unknown, e: { key: string }) => ({ value: store.get(e.key) }))
  on('store.set', (_$: unknown, e: { key: string; value: unknown }) => { store.set(e.key, e.value); return { value: undefined } })
  on('store.delete', (_$: unknown, e: { key: string }) => { store.delete(e.key); return { value: undefined } })
  on('prompt.submit', (_$: unknown, e: { text: string }) => { prompts.push(e.text); return { text: e.text } })
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('command.run', { command: 'clear' }, () => ({ text: '' }))
  on('command.run', { command: 'model' }, (_$: unknown, e: { args: string }) => { models.push(e.args); return { text: '' } })
  on('command.register', (_$: unknown, e: { name: string }) => ({ value: { command: e.name } }) as never)
  on('tool.register', (_$: unknown, e: { name: string }) => ({ value: { tool: `mcp__crew__${e.name}` } }) as never)
  on('session.start', () => ({ cwd: '/w' }) as never)

 return { prompts, files, models }
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

// crew-code#12: refresh on request in any mode, an honest needs-you list, the refresh shown on the row,
// and an assignment that survives a refresh.
const refreshTool = (reason: string) => ({ tool: 'mcp__crew__crew_refresh', reason }) as never

test('crew_refresh refreshes a member in package mode, and leaves its mode as it was', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-crew', 'Mars'], ['refresh:Mars', 'package']])
  const clock = mock.clock(on, { now: NOW })
  const { prompts, files } = crewSession(on, store, { percent: 53 })
  const beat = () => JSON.parse(files.get('/home/test/.claude/crew/id-crew.json') ?? '{}')

  await $.turn.start({ text: 'refresh now please', turnId: 't1' })
  const ran = await $.tool.call(refreshTool('the Supervisor asked'))
  expect(String((ran as { result?: unknown }).result)).toContain('End your turn')
  expect(beat().refresh.phase).toBe('due')

  await $.turn.complete(answer('Refresh requested.'))
  await clock.advance(600)
  expect(prompts[0]).toContain('HANDOVER_2026-10-06_Mars.md')

  await $.turn.complete(answer('Written.\nCREW-HANDOVER-WRITTEN', 't2'))
  await clock.advance(600)
  expect(prompts[1]).toContain('You are Mars')
  expect(store.get('refresh:Mars')).toBe('package')
})

test('crew_refresh works with refresh off too, and a second call while one runs changes nothing', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-crew', 'Mars']])
  mock.clock(on, { now: NOW })
  crewSession(on, store, { percent: 30 })

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call(refreshTool('the owner asked'))
  const again = await $.tool.call(refreshTool('asked twice'))

  expect(String((again as { result?: unknown }).result)).toContain('already')
  expect(store.has('refresh:Mars')).toBe(false)
})

test('an MCP elicitation needs the owner, naming the server, until it is answered', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-fovea', 'Jupiter']])
  mock.clock(on, { now: NOW })
  const written = beatsWritten(on, store)
  on('classic.Elicitation', () => ({}) as never)
  on('classic.ElicitationResult', () => ({}) as never)

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.classic.Elicitation({ mcp_server_name: 'macula', message: 'Approve the new key' } as never)
  expect(written.at(-1)?.state).toBe('needs-you')
  expect(written.at(-1)?.lastLine).toContain('macula')
  expect(written.at(-1)?.lastLine).toContain('Approve the new key')

  await $.classic.ElicitationResult({ mcp_server_name: 'macula', action: 'accept' } as never)
  expect(written.at(-1)?.state).toBe('working')
})

test('an engine notification that wants the owner sets needs-you; the idle prompt does not', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-fovea', 'Jupiter']])
  mock.clock(on, { now: NOW })
  const written = beatsWritten(on, store)
  on('classic.Notification', () => ({}) as never)

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete(answer('Done.'))
  await $.classic.Notification({ notification_type: 'idle_prompt', message: 'Claude is waiting for your input' } as never)
  expect(written.at(-1)?.state).toBe('idle')

  await $.classic.Notification({ notification_type: 'plugin_reload', message: 'Enable hot reloading for this session?' } as never)
  expect(written.at(-1)?.state).toBe('needs-you')
  expect(written.at(-1)?.lastLine).toContain('Enable hot reloading')
})

const paneOf = async ($: { ui: { mount: (x: never) => Promise<{ find: (q: { text: RegExp }) => Promise<unknown> }> } }) =>
  $.ui.mount({
    plugin: 'crew', surface: 'terminal', component: 'Pane', requestId: 'crew',
    props: { title: 'Crew', isFocused: false, bodyColumns: 140, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  } as never)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dashboardOf = (on: any, rows: Record<string, unknown>[]) => {
  mock.env(on, { HOME: '/home/test' })
  const files = Object.fromEntries(rows.map(row => [`${String(row.name).toLowerCase()}.json`, JSON.stringify({ ...JSON.parse(beat(String(row.name), 'idle', NOW - 1_000)), ...row })]))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', () => ({ value: Object.keys(files).map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: files[e.path.split('/').at(-1) ?? ''] ?? '' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
}

test('the dashboard opens with a needs-you list naming each tab and what waits on the owner', async ($, on) => {
  mock.clock(on, { now: NOW })
  dashboardOf(on, [
    { name: 'Venus', state: 'needs-you', lastLine: 'Push 3 commits to macula-rust?' },
    { name: 'Jupiter', state: 'needs-you', lastLine: 'macula asks: Approve the new key' },
    { name: 'Mars', state: 'working', lastTool: 'Bash' },
  ])

  await $.command.run({ command: 'crew', args: '' } as never)
  const ui = await paneOf($)
  expect(await ui.find({ text: /needs you \(2\)/ })).toBeDefined()
  expect(await ui.find({ text: /Venus tab: Push 3 commits to macula-rust\?/ })).toBeDefined()
  expect(await ui.find({ text: /Jupiter tab: macula asks: Approve the new key/ })).toBeDefined()
  expect(await ui.find({ text: /Mars tab/ })).toBeUndefined()
})

test('a waiting row says what it waits on, even when nothing was named', async ($, on) => {
  mock.clock(on, { now: NOW })
  dashboardOf(on, [{ name: 'Mars', state: 'waiting', waitingOn: '' }])

  await $.command.run({ command: 'crew', args: '' } as never)
  const ui = await paneOf($)
  expect(await ui.find({ text: /waiting on nothing it named/ })).toBeDefined()
})

test('after a refresh the row shows the context it dropped from', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-crew', 'Mars']])
  const clock = mock.clock(on, { now: NOW })
  const context = { percent: 53 }
  const { files } = crewSession(on, store, context)
  const beat = () => JSON.parse(files.get('/home/test/.claude/crew/id-crew.json') ?? '{}')

  await $.command.run({ command: 'crew-refresh', args: 'now' } as never)
  await clock.advance(600)
  await $.turn.complete(answer('Written.\nCREW-HANDOVER-WRITTEN'))
  context.percent = 4
  await clock.advance(600)

  expect(beat().refresh).toMatchObject({ fromPercent: 53 })
})

test('a refreshed row reads "refreshed 53% -> 4%"', async ($, on) => {
  mock.clock(on, { now: NOW })
  dashboardOf(on, [{ name: 'Mars', contextPercent: 4, refresh: { threshold: 0, isAuto: false, isPackage: false, refreshedAt: NOW - 60_000, phase: 'none', fromPercent: 53 } }])

  await $.command.run({ command: 'crew', args: '' } as never)
  const ui = await paneOf($)
  expect(await ui.find({ text: /refreshed 53% → 4%/ })).toBeDefined()
})

test('the resume prompt points at the card the member holds and its newest brief', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-crew', 'Mars']])
  const clock = mock.clock(on, { now: NOW })
  const { prompts, files } = crewSession(on, store, { percent: 30 })
  board(on, { card: { card_id: CARD, issue_ref: 'macula-io/macula#75', work_package: 'macula-io/macula#70' } })
  files.set('/home/test/.claude/sessions/BRIEF_2026-10-05_Mars.md', 'old brief')
  files.set('/home/test/.claude/sessions/BRIEF_2026-10-06_Mars.md', 'the brief')
  files.set('/home/test/.claude/sessions/BRIEF_2026-10-06_Venus.md', 'not mine')

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call(claimNext)
  await $.turn.complete(answer('Claimed.'))
  await $.command.run({ command: 'crew-refresh', args: 'now' } as never)
  await clock.advance(600)
  await $.turn.complete(answer('Written.\nCREW-HANDOVER-WRITTEN', 't2'))
  await clock.advance(600)

  const resume = prompts.at(-1) ?? ''
  expect(resume).toContain('macula-io/macula#75')
  expect(resume).toContain('BRIEF_2026-10-06_Mars.md')
  expect(resume).not.toContain('Venus')
})

test('the Supervisor is told to put each brief in a file, so it survives the member\'s refresh', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-crew', 'Supervisor']])
  mock.clock(on, { now: NOW })
  crewSession(on, store, { percent: 30 })
  on('prompt.compose', () => ({ sections: [] }) as never)

  const composed = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
  expect(composed.sections.some((section: { text: string }) => section.text.includes('BRIEF_'))).toBe(true)
})

test('every member is told to call crew_refresh when told to refresh, not to write a handover by hand', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-crew', 'Mars']])
  mock.clock(on, { now: NOW })
  crewSession(on, store, { percent: 30 })
  on('prompt.compose', () => ({ sections: [] }) as never)

  const composed = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
  expect(composed.sections.some((section: { text: string }) => section.text.includes('crew_refresh'))).toBe(true)
})

// crew-code#13: one menu per change, routine asks queued and offered together, the queue on the dashboard.
const ASKS_DIR = '/home/test/.claude/crew/asks'
const queueAsk = (ask: string) => ({ tool: 'mcp__crew__queue_ask', ask }) as never

test('queue_ask holds a routine ask for the owner and says how many wait', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-crew', 'Mars']])
  mock.clock(on, { now: NOW })
  const { files } = crewSession(on, store, { percent: 30 })

  await $.tool.call(queueAsk('Delete merged branch neptunus/49-roll1 in macula-station?'))
  const ran = await $.tool.call(queueAsk('Remove worktree neptunus-13?'))

  const queued = [...files.entries()].filter(([path]) => path.startsWith(`${ASKS_DIR}/`)).map(([, text]) => JSON.parse(text))
  expect(queued.map(ask => ask.ask)).toEqual(['Delete merged branch neptunus/49-roll1 in macula-station?', 'Remove worktree neptunus-13?'])
  expect(queued.every(ask => ask.from === 'Mars')).toBe(true)
  expect(String((ran as { result?: unknown }).result)).toContain('2 asks waiting')
})

test('take_asks hands over every queued ask, oldest first, and empties the queue', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-crew', 'Supervisor']])
  mock.clock(on, { now: NOW })
  const { files } = crewSession(on, store, { percent: 30 })
  files.set(`${ASKS_DIR}/2000-b.json`, JSON.stringify({ from: 'Venus', ask: 'Delete branch venus/x?', at: 2000 }))
  files.set(`${ASKS_DIR}/1000-a.json`, JSON.stringify({ from: 'Mars', ask: 'Remove worktree mars-y?', at: 1000 }))

  const ran = String(((await $.tool.call({ tool: 'mcp__crew__take_asks' } as never)) as { result?: unknown }).result)

  expect(ran.indexOf('Mars: Remove worktree mars-y?')).toBeLessThan(ran.indexOf('Venus: Delete branch venus/x?'))
  expect(ran).toContain('multiSelect')
  expect([...files.keys()].filter(path => path.startsWith(`${ASKS_DIR}/`))).toEqual([])
})

test('the dashboard header says how many asks wait for the owner', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home/test' })
  const rows = { 'mars.json': beat('Mars', 'working', NOW - 1_000) }
  const asks = ['1-a.json', '2-b.json', '3-c.json']
  on('fs.exists', () => ({ value: true }))
  on('fs.list', (_$: unknown, e: { path: string }) => ({
    value: (e.path.endsWith('/asks') ? asks : Object.keys(rows)).map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: rows[e.path.split('/').at(-1) as 'mars.json'] ?? '' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  await $.command.run({ command: 'crew', args: '' } as never)
  const ui = await paneOf($)
  expect(await ui.find({ text: /3 asks waiting/ })).toBeDefined()
})

test('every session is told: one menu per change, routine asks to queue_ask; the Supervisor offers them with take_asks', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-crew', 'Supervisor']])
  mock.clock(on, { now: NOW })
  crewSession(on, store, { percent: 30 })
  on('prompt.compose', () => ({ sections: [] }) as never)

  const composed = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
  const text = composed.sections.map((section: { text: string }) => section.text).join('\n')
  expect(text).toContain('one menu per change')
  expect(text).toContain('queue_ask')
  expect(text).toContain('take_asks')
})

// crew-code#14: budget gauges. The weekly window comes from the engine's rate-limit reading (seven_day);
// the Fable gauge has no reading and is set by the owner with /crew-budget.
const DAY = 24 * 3600_000
const weekly = (percent: number, resetsInMs: number) => ({ kind: 'seven_day', percentUsed: percent, resetsAt: new Date(NOW + resetsInMs).toISOString() })

test('a beat carries the weekly window: percent used and when it resets', async ($, on) => {
  mock.clock(on, { now: NOW })
  const files = crewSession(on, new Map([['name:id-crew', 'Mars']]), { percent: 10, rateLimits: [weekly(91, 3 * DAY)] }).files
  const latest = () => JSON.parse(files.get('/home/test/.claude/crew/id-crew.json') ?? '{}')

  await $.turn.start({ text: 'go', turnId: 't1' })
  expect(latest().weekly).toMatchObject({ percent: 91, resetsAt: NOW + 3 * DAY })
})

test('the dashboard shows the weekly gauge, its reset, and a run-out that comes before the reset', async ($, on) => {
  mock.clock(on, { now: NOW })
  // 91% used with 3 of 7 days left: at this pace it runs out in well under a day, before the reset.
  dashboardOf(on, [{ name: 'Mars', weekly: { percent: 91, resetsAt: NOW + 3 * DAY } }])

  await $.command.run({ command: 'crew', args: '' } as never)
  const ui = await paneOf($)
  expect(await ui.find({ text: /weekly 91%/ })).toBeDefined()
  expect(await ui.find({ text: /resets in 3d/ })).toBeDefined()
  expect(await ui.find({ text: /runs out in \d+h, before the reset/ })).toBeDefined()
})

test('/crew-budget sets the Fable gauge, and the dashboard shows it with when it was set', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-crew', 'Supervisor']])
  mock.clock(on, { now: NOW })
  crewSession(on, store, { percent: 20 })

  const set = await $.command.run({ command: 'crew-budget', args: 'fable 56' } as never)
  expect(set.text).toContain('Fable 56%')
  expect(store.get('budget:fable')).toMatchObject({ percent: 56, at: NOW })
  const shown = await $.command.run({ command: 'crew-budget', args: '' } as never)
  expect(shown.text).toContain('Fable 56%')
})

test('the Supervisor reads the budget in its prompt as a measurement, never as an order to slow down', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-crew', 'Supervisor'], ['budget:fable', { percent: 56, at: NOW }]])
  mock.clock(on, { now: NOW })
  crewSession(on, store, { percent: 20, rateLimits: [weekly(91, 3 * DAY)] })
  on('prompt.compose', () => ({ sections: [] }) as never)

  const composed = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
  const budget = composed.sections.find((section: { id: string }) => section.id === 'crew:budget')?.text ?? ''
  expect(budget).toContain('weekly 91%')
  expect(budget).toContain('Fable 56%')
  expect(budget).toContain('before the reset')
  expect(budget).toContain("change the crew's pace only when the owner says so")
  expect(budget).not.toMatch(/hold|only small/)
})

// crew-code#15: a session switching INTO needs-you rings its own tab's bell and shows a desktop
// notification, once per switch; /crew-sound mutes either or both, crew-wide.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const alerting = (on: any, store: Map<string, unknown>) => {
  const runs: string[][] = []
  const written: { state: string }[] = []
  mock.env(on, { HOME: '/home/test' })
  on('fs.exists', () => ({ value: false }))
  on('fs.write', (_$: unknown, e: { text: string }) => { written.push(JSON.parse(e.text)); return { value: undefined } })
  on('fs.list', () => ({ value: [] }))
  on('session.id', () => ({ value: 'id-terra' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent: 20 }, rateLimits: [] } }))
  on('session.repo', () => ({ value: null }))
  on('session.cwd', () => ({ value: '/w' }))
  on('session.root', () => ({ value: '/w' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.turns', () => ({ value: 1 }))
  on('session.messages', () => ({ value: [] }))
  on('process.run', (_$: unknown, e: { argv: string[] }) => { runs.push(e.argv); return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } })
  on('store.get', (_$: unknown, e: { key: string }) => ({ value: store.get(e.key) }))
  on('store.set', (_$: unknown, e: { key: string; value: unknown }) => { store.set(e.key, e.value); return { value: undefined } })
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  const bells = () => runs.filter(argv => argv.join(' ').includes('\\a')).length
  const notes = () => runs.filter(argv => argv[0] === 'notify-send')
  return { runs, written, bells, notes }
}

test('a switch into needs-you rings the bell once and notifies once, naming the member and what waits', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-terra', 'Terra']])
  mock.clock(on, { now: NOW })
  const { bells, notes } = alerting(on, store)

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete(answer('Push the fleet commit 3f2a1bc?'))
  // The row stays needs-you through more beats: no repeat.
  await $.tool.call({ tool: 'mcp__crew__report_progress', task: 'x', step: 1, of: 2 } as never).catch(() => null)

  expect(bells()).toBe(1)
  expect(notes()).toHaveLength(1)
  expect(notes()[0]?.join(' ')).toContain('Terra')
  expect(notes()[0]?.join(' ')).toContain('Push the fleet commit 3f2a1bc?')
})

test('a second switch into needs-you after working again alerts again', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-terra', 'Terra']])
  mock.clock(on, { now: NOW })
  const { bells, notes } = alerting(on, store)

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete(answer('First?'))
  await $.turn.start({ text: 'yes', turnId: 't2' })
  await $.turn.complete(answer('Second?', 't2'))

  expect(bells()).toBe(2)
  expect(notes()).toHaveLength(2)
})

test('/crew-sound mutes the bell, the notification or both, crew-wide', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-terra', 'Terra']])
  mock.clock(on, { now: NOW })
  const { bells, notes } = alerting(on, store)

  expect((await $.command.run({ command: 'crew-sound', args: 'notify' } as never)).text).toContain('notification only')
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete(answer('One?'))
  expect([bells(), notes().length]).toEqual([0, 1])

  await $.command.run({ command: 'crew-sound', args: 'bell' } as never)
  await $.turn.start({ text: 'go', turnId: 't2' })
  await $.turn.complete(answer('Two?', 't2'))
  expect([bells(), notes().length]).toEqual([1, 1])

  await $.command.run({ command: 'crew-sound', args: 'off' } as never)
  await $.turn.start({ text: 'go', turnId: 't3' })
  await $.turn.complete(answer('Three?', 't3'))
  expect([bells(), notes().length]).toEqual([1, 1])
  expect(store.get('sound')).toBe('off')
})

// crew-code#16: the factory ledger. Append-only JSON lines, one file per session per ISO week, under
// ~/.claude/crew/ledger/<week>/. The mod logs what it sees; crew_log records what only the crew knows.
const LEDGER = '/home/test/.claude/crew/ledger'
const ledgerOf = (files: Map<string, string>) =>
  [...files.entries()].filter(([path]) => path.startsWith(`${LEDGER}/`)).flatMap(([, text]) => text.trim().split('\n').map(line => JSON.parse(line)))

test('crew_log appends a milestone with the package, the member, its cost and the weekly gauge', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-crew', 'Supervisor']])
  mock.clock(on, { now: NOW })
  const { files } = crewSession(on, store, { percent: 20, rateLimits: [weekly(88, 3 * DAY)] })

  const ran = await $.tool.call({ tool: 'mcp__crew__crew_log', package: 'macula-io/macula#75', event: 'assigned', note: 'to Mars' } as never)
  await $.tool.call({ tool: 'mcp__crew__crew_log', package: 'macula-io/macula#75', event: 'owner_yes', note: '' } as never)

  expect(String((ran as { result?: unknown }).result)).toContain('logged')
  const events = ledgerOf(files)
  expect(events).toHaveLength(2)
  expect(events[0]).toMatchObject({ event: 'assigned', package: 'macula-io/macula#75', name: 'Supervisor', note: 'to Mars', weekly: 88, at: NOW })
  expect([...files.keys()].some(path => /ledger\/\d{4}-W\d{2}\/id-crew\.jsonl$/.test(path))).toBe(true)
})

test('crew_log refuses an event it does not know, and logs nothing', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-crew', 'Mars']])
  mock.clock(on, { now: NOW })
  const { files } = crewSession(on, store, { percent: 20 })

  const ran = await $.tool.call({ tool: 'mcp__crew__crew_log', package: 'macula-io/macula#75', event: 'vibes', note: '' } as never)

  expect(String((ran as { result?: unknown }).result)).toContain('release')
  expect(ledgerOf(files)).toHaveLength(0)
})

test('the mod logs a needs-you interval with how long the owner was waited on, tagged with the package', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-crew', 'Mars'], ['package:Mars', 'macula-io/macula#70']])
  const clock = mock.clock(on, { now: NOW })
  const { files } = crewSession(on, store, { percent: 20 })

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete(answer('Push 3 commits?'))
  await clock.advance(90_000)
  await $.turn.start({ text: 'yes', turnId: 't2' })

  const waited = ledgerOf(files).filter(event => event.event === 'owner_wait')
  expect(waited).toHaveLength(1)
  expect(waited[0]).toMatchObject({ name: 'Mars', package: 'macula-io/macula#70', ms: 90_000 })
})

test('a claimed card and a menu shown are logged on their own', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-crew', 'Mars']])
  mock.clock(on, { now: NOW })
  const { files } = crewSession(on, store, { percent: 20 })
  board(on, { card: { card_id: CARD, issue_ref: 'macula-io/macula#75', work_package: 'macula-io/macula#70' } })
  on('tool.call', { tool: 'AskUserQuestion' }, () => ({ result: { answers: {} } }) as never)

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call(claimNext)
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)

  const kinds = ledgerOf(files).map(event => `${event.event} ${event.package ?? ''}`.trim())
  expect(kinds).toContain('card_claimed macula-io/macula#70')
  expect(kinds).toContain('menu macula-io/macula#70')
})

test('/crew-report sums a week per package: cycle time, owner wait, rework, releases, cost; and per member', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-crew', 'Supervisor']])
  mock.clock(on, { now: NOW })
  const { files } = crewSession(on, store, { percent: 20 })
  const pkg = 'macula-io/macula#75'
  const line = (event: Record<string, unknown>) => JSON.stringify({ package: pkg, note: '', weekly: 88, ...event })
  files.set(`${LEDGER}/1970-W01/id-sup.jsonl`, [
    line({ event: 'assigned', name: 'Supervisor', at: 0, cost: 1 }),
    line({ event: 'sent_back', name: 'Supervisor', at: 1_000, cost: 1.5 }),
    line({ event: 'closed', name: 'Supervisor', at: 3 * 3600_000, cost: 2 }),
  ].join('\n') + '\n')
  files.set(`${LEDGER}/1970-W01/id-mars.jsonl`, [
    line({ event: 'card_claimed', name: 'Mars', at: 60_000, cost: 10 }),
    line({ event: 'owner_wait', name: 'Mars', at: 120_000, cost: 12, ms: 600_000 }),
    line({ event: 'release', name: 'Mars', at: 2 * 3600_000, cost: 14.5 }),
    line({ event: 'fix_after_ship', name: 'Mars', at: 2.5 * 3600_000, cost: 15 }),
  ].join('\n') + '\n')

  const report = (await $.command.run({ command: 'crew-report', args: '1970-W01' } as never)).text ?? ''

  expect(report).toContain(pkg)
  expect(report).toMatch(/cycle 3h/)
  expect(report).toMatch(/owner wait 10m/)
  expect(report).toMatch(/rework 2/)
  expect(report).toMatch(/releases 1/)
  expect(report).toMatch(/cost \$6\.00/)
  expect(report).toMatch(/Mars.*\$5\.00/)
})

test('the Supervisor is told which milestones to log, members which of theirs', async ($, on) => {
  mock.clock(on, { now: NOW })
  crewSession(on, new Map([['name:id-crew', 'Supervisor']]), { percent: 20 })
  on('prompt.compose', () => ({ sections: [] }) as never)
  const compose = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [], tools: [], outputStyle: null, traits: [] } as never

  const text = (await $.prompt.compose(compose)).sections.map((section: { text: string }) => section.text).join('\n')
  expect(text).toContain('crew_log')
  expect(text).toContain('owner_yes')
})

// crew-code#9: a reviewing state, inferred from a reviewer subagent or a review skill, or declared.
test('a reviewer subagent shows reviewing while it runs, then working again', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-fovea', 'Venus']])
  mock.clock(on, { now: NOW })
  const written = beatsWritten(on, store)
  const during: string[] = []
  on('tool.call', { tool: 'Agent' }, () => { during.push(written.at(-1)?.state ?? ''); return { result: { content: [] } } as never })

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Agent', subagent_type: 'faber-adversary', description: 'attack the design', prompt: 'x' } as never)
  await $.tool.call({ tool: 'Agent', subagent_type: 'general-purpose', model: 'fable', description: 'review the diff', prompt: 'x' } as never)
  await $.tool.call({ tool: 'Agent', subagent_type: 'Explore', description: 'find the handler', prompt: 'x' } as never)

  expect(during).toEqual(['reviewing', 'reviewing', 'working'])
  expect(written.at(-1)?.state).toBe('working')
})

test('a review skill shows reviewing while it runs', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-fovea', 'Venus']])
  mock.clock(on, { now: NOW })
  const written = beatsWritten(on, store)
  let during = ''
  on('tool.call', { tool: 'Skill' }, () => { during = written.at(-1)?.state ?? ''; return { result: 'ok' } as never })

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Skill', skill: 'code-review', args: 'high' } as never)

  expect(during).toBe('reviewing')
  expect(written.at(-1)?.state).toBe('working')
})

test('a reviewer still running in the background when the turn ends leaves the row reviewing, not waiting', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-fovea', 'Venus']])
  mock.clock(on, { now: NOW })
  const written = beatsWritten(on, store)
  on('classic.Stop', () => ({}) as never)
  on('agent.list', () => ({ value: [{ id: 'a1', status: 'running' }] }) as never)

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'a1', type: 'subagent', agent_type: 'faber-adversary', description: 'review the claim' }], session_crons: [] } as never)
  await $.turn.complete(answer('Fable is reviewing.'))

  expect(written.at(-1)).toMatchObject({ state: 'reviewing', waitingOn: 'faber-adversary: review the claim' })
})

test('a member declares a review with report_progress phase, and it holds across tool calls until it says working', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-fovea', 'Venus']])
  mock.clock(on, { now: NOW })
  const written = beatsWritten(on, store)
  on('tool.call', { tool: 'Read' }, () => ({ result: 'text' }) as never)

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'mcp__crew__report_progress', task: 'review #48', step: 0, of: 3, phase: 'reviewing' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/w/a.erl' } as never)
  expect(written.at(-1)?.state).toBe('reviewing')

  await $.tool.call({ tool: 'mcp__crew__report_progress', task: 'fix #48', step: 1, of: 3, phase: 'working' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/w/a.erl' } as never)
  expect(written.at(-1)?.state).toBe('working')
})

test('the dashboard draws a reviewing row', async ($, on) => {
  mock.clock(on, { now: NOW })
  dashboardOf(on, [{ name: 'Venus', state: 'reviewing', lastTool: 'Agent' }])

  await $.command.run({ command: 'crew', args: '' } as never)
  const ui = await paneOf($)
  expect(await ui.find({ text: /reviewing/ })).toBeDefined()
})

// crew-code#10: worker and reviewer models. The reviewer model is enforced on review subagents.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const agentModels = (on: any) => {
  const models: string[] = []
  on('tool.call', { tool: 'Agent' }, (_$: unknown, e: { model?: string }) => { models.push(e.model ?? ''); return { result: { content: [] } } as never })
  return models
}

test('a review subagent runs on the reviewer model, whatever the session asked for; other subagents are untouched', async ($, on) => {
  const store = new Map<string, unknown>([['name:id-fovea', 'Venus']])
  mock.clock(on, { now: NOW })
  beatsWritten(on, store)
  const models = agentModels(on)

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Agent', subagent_type: 'faber-adversary', model: 'opus', description: 'attack', prompt: 'x' } as never)
  await $.tool.call({ tool: 'Agent', subagent_type: 'code-reviewer', description: 'review the diff', prompt: 'x' } as never)
  await $.tool.call({ tool: 'Agent', subagent_type: 'Explore', model: 'haiku', description: 'find it', prompt: 'x' } as never)

  expect(models).toEqual(['fable', 'fable', 'haiku'])
})

test('reviewer_model sets the model reviews run on', { options: { reviewer_model: 'opus' } }, async ($, on) => {
  const store = new Map<string, unknown>([['name:id-fovea', 'Venus']])
  mock.clock(on, { now: NOW })
  beatsWritten(on, store)
  const models = agentModels(on)

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Agent', subagent_type: 'faber-adversary', description: 'attack', prompt: 'x' } as never)
  await $.tool.call({ tool: 'Agent', subagent_type: 'general-purpose', model: 'opus', description: 'review the design', prompt: 'x' } as never)

  expect(models).toEqual(['opus', 'opus'])
})

test('every session is told which model its reviews run on', { options: { reviewer_model: 'opus' } }, async ($, on) => {
  mock.clock(on, { now: NOW })
  crewSession(on, new Map([['name:id-crew', 'Mars']]), { percent: 20 })
  on('prompt.compose', () => ({ sections: [] }) as never)
  const compose = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [], tools: [], outputStyle: null, traits: [] } as never

  const text = (await $.prompt.compose(compose)).sections.map((section: { text: string }) => section.text).join('\n')
  expect(text).toMatch(/[Rr]eviews run on opus/)
})

test('a row on the dashboard names its session model', async ($, on) => {
  mock.clock(on, { now: NOW })
  dashboardOf(on, [{ name: 'Pluto', state: 'working', model: 'claude-sonnet-5-5' }])

  await $.command.run({ command: 'crew', args: '' } as never)
  const ui = await paneOf($)
  expect(await ui.find({ text: /sonnet-5-5/ })).toBeDefined()
})

// crew-code#17: an assignment can name a model; the mod switches the member's live session to it with /model
// (the engine runs a plugin's command as if the owner typed it, once the session is idle) and back to the
// member's configured model when the package ends or the member parks.
const switchTo = (model: string, pkg = 'macula-io/macula-torture#1', reason = 'torture run') =>
  ({ tool: 'mcp__crew__crew_model', model, package: pkg, reason }) as never
const MEMBER_MODELS = { options: { members: 'Mars, Venus', member_models: 'Mars:claude-opus-5-5', worker_model: 'claude-opus-5-5' } }

test('crew_model switches the live session to the assignment\'s model once the turn is idle, and the row says why', MEMBER_MODELS, async ($, on) => {
  const store = new Map<string, unknown>([['name:id-crew', 'Mars']])
  const clock = mock.clock(on, { now: NOW })
  const { files, models } = crewSession(on, store, { percent: 20 })
  const beat = () => JSON.parse(files.get('/home/test/.claude/crew/id-crew.json') ?? '{}')

  await $.turn.start({ text: 'go', turnId: 't1' })
  const ran = await $.tool.call(switchTo('claude-sonnet-5-5'))
  expect(String((ran as { result?: unknown }).result)).toContain('claude-sonnet-5-5')
  await $.turn.complete(answer('Starting the torture run.'))
  await clock.advance(600)

  expect(models).toEqual(['claude-sonnet-5-5'])
  expect(beat().modelWhy).toContain('macula-io/macula-torture#1')
  expect(beat().modelWhy).toContain('claude-opus-5-5')
})

test('parking switches the member back to its configured model', MEMBER_MODELS, async ($, on) => {
  const store = new Map<string, unknown>([['name:id-crew', 'Mars']])
  const clock = mock.clock(on, { now: NOW })
  const { files, models } = crewSession(on, store, { percent: 20 })
  const beat = () => JSON.parse(files.get('/home/test/.claude/crew/id-crew.json') ?? '{}')

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call(switchTo('claude-sonnet-5-5'))
  await $.tool.call({ tool: 'mcp__crew__crew_park', parked: 1, reason: 'told to stop' } as never)
  await $.turn.complete(answer('Parked.'))
  await clock.advance(600)

  expect(models).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5'])
  expect(beat().modelWhy ?? '').toBe('')
})

test('finishing a card of the switched package switches back; a card of another package does not', MEMBER_MODELS, async ($, on) => {
  const store = new Map<string, unknown>([['name:id-crew', 'Mars']])
  const clock = mock.clock(on, { now: NOW })
  const { models } = crewSession(on, store, { percent: 20 })
  const finish = { tool: 'mcp__macula__mesh_call', procedure: 'mcl-kanban/finish_card', args: { card_id: CARD, result: 'done' } } as never
  board(on, { ok: 1 })

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call(switchTo('claude-sonnet-5-5'))
  store.set('package:Mars', 'macula-io/other#2')
  await $.tool.call(finish)
  await $.turn.complete(answer('One done.'))
  await clock.advance(600)
  expect(models).toEqual(['claude-sonnet-5-5'])

  store.set('package:Mars', 'macula-io/macula-torture#1')
  await $.turn.start({ text: 'go', turnId: 't2' })
  await $.tool.call(finish)
  await $.turn.complete(answer('Torture run done.', 't2'))
  await clock.advance(600)
  expect(models).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5'])
})

test('crew_model back returns to worker_model when the member has no entry of its own', { options: { members: 'Venus', worker_model: 'claude-opus-5-5' } }, async ($, on) => {
  const store = new Map<string, unknown>([['name:id-crew', 'Venus']])
  const clock = mock.clock(on, { now: NOW })
  const { models } = crewSession(on, store, { percent: 20 })

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call(switchTo('claude-sonnet-5-5'))
  await $.tool.call({ tool: 'mcp__crew__crew_model', model: 'back', package: 'macula-io/macula-torture#1', reason: 'done' } as never)
  await $.turn.complete(answer('Done.'))
  await clock.advance(600)

  expect(models.at(-1)).toBe('claude-opus-5-5')
})

test('a row names the model it switched to and why', async ($, on) => {
  mock.clock(on, { now: NOW })
  dashboardOf(on, [{ name: 'Mars', state: 'working', model: 'claude-sonnet-5-5', modelWhy: 'for macula-io/macula-torture#1 (torture run), back to claude-opus-5-5 after' }])

  await $.command.run({ command: 'crew', args: '' } as never)
  const ui = await paneOf($)
  expect(await ui.find({ text: /for macula-io\/macula-torture#1/ })).toBeDefined()
})

test('the Supervisor is told to name a model in the brief, members to call crew_model with it', async ($, on) => {
  mock.clock(on, { now: NOW })
  crewSession(on, new Map([['name:id-crew', 'Supervisor']]), { percent: 20 })
  on('prompt.compose', () => ({ sections: [] }) as never)
  const compose = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [], tools: [], outputStyle: null, traits: [] } as never

  const text = (await $.prompt.compose(compose)).sections.map((section: { text: string }) => section.text).join('\n')
  expect(text).toContain('crew_model')
  expect(text).toMatch(/brief/)
})

// Other crew files share the beats directory (roster.json, room.json from bin/crew), and a beat from another
// host or an older mod can lack fields: the pane draws every beat and skips what is not one.
const STRAY_FILES: Record<string, string> = {
  'venus.json': beat('Venus', 'working', NOW - 5_000, 'on it'),
  'roster.json': JSON.stringify({ Venus: 'a'.repeat(64), Terra: 'b'.repeat(64) }),
  'room.json': JSON.stringify({ room: 'c'.repeat(64), by: 'Supervisor' }),
  'terra.json': JSON.stringify({ sessionId: 'ses_terra', name: 'Terra', state: 'idle', beatAt: NOW - 1_000, agent: 'opencode' }),
}

test('the pane draws every beat, skips files that are not beats, and defaults missing fields', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home/test' })
  on('fs.exists', () => ({ value: true }))
  on('fs.list', () => ({ value: Object.keys(STRAY_FILES).map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }))
  on('fs.read', (_$, e) => ({ value: STRAY_FILES[e.path.split('/').at(-1) ?? ''] ?? '' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  await $.command.run({ command: 'crew', args: '' } as never)

  const ui = await $.ui.mount({
    plugin: 'crew', surface: 'terminal', component: 'Pane', requestId: 'crew',
    props: { title: 'Crew', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  expect(await ui.find({ text: /2\/2 online/ })).toBeDefined()
  expect(await ui.find({ text: /Venus/ })).toBeDefined()
  expect(await ui.find({ text: /Terra/ })).toBeDefined()
})

// crew-code#24 (a): the Supervisor restarts a member headless through the launcher. The launcher's
// own path rides the session's launch env (CREW_BIN); `crew` on PATH is the fallback. The tool reports
// what the launcher said, and refuses a name that is not a plain member name.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const restartMocks = (on: any, runs: string[][], reply?: { exitCode: number; stderr: string }) => {
  mock.env(on, { HOME: '/home/test' })
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
  on('session.id', () => ({ value: 'id-mercurius' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent: 10 }, rateLimits: [] } }))
  on('session.repo', () => ({ value: null }))
  on('session.cwd', () => ({ value: '/w' }))
  on('session.root', () => ({ value: '/w' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.turns', () => ({ value: 1 }))
  on('session.messages', () => ({ value: [] }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('store.delete', () => ({ value: undefined }))
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    runs.push(e.argv)
    return reply
      ? { value: { exitCode: reply.exitCode, stdout: '', stderr: `${reply.stderr}\n`, isStdoutTruncated: false, isStderrTruncated: false } }
      : { value: { exitCode: 0, stdout: 'Venus: stopped\nVenus: started headless in tmux session crew-venus\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

test('crew_restart restarts a member through the launcher and reports it (#24)', async ($, on) => {
  const runs: string[][] = []
  mock.clock(on, { now: NOW })
  restartMocks(on, runs)

  const ran = await $.tool.call({ tool: 'mcp__crew__crew_restart', name: 'Venus', reason: 'stalled', fresh: 1 } as never)

  expect(String(ran.text ?? ran.result)).toContain('Venus restarted fresh')
  expect(String(ran.text ?? ran.result)).toContain('started headless')
  expect(runs.at(-1)).toEqual(['crew', 'restart', 'Venus', '--fresh'])

  const bad = await $.tool.call({ tool: 'mcp__crew__crew_restart', name: 'not a name', reason: 'x', fresh: 0 } as never)
  expect(String(bad.text ?? bad.result)).toContain('Not restarted')
  expect(runs).toHaveLength(1)
})

// A failing launcher is reported with its own last line, not swallowed.
test('crew_restart reports what the launcher refused (#24)', async ($, on) => {
  const runs: string[][] = []
  mock.clock(on, { now: NOW })
  restartMocks(on, runs, { exitCode: 1, stderr: 'crew: refusing to stop Venus: agent runs in process group 1, not its own' })

  const ran = await $.tool.call({ tool: 'mcp__crew__crew_restart', name: 'Venus', reason: 'stalled', fresh: 0 } as never)

  expect(String(ran.text ?? ran.result)).toContain('Not restarted')
  expect(String(ran.text ?? ran.result)).toContain('refusing to stop')
  expect(runs.at(-1)).toEqual(['crew', 'restart', 'Venus'])
})

// crew-code#24b: the dashboard flags a session whose room instructions have waited past the receipt
// threshold, so a lost message is seen instead of assumed delivered.
const RECEIPT_FILES: Record<string, string> = {
  'supervisor.json': JSON.stringify({ ...JSON.parse(beat('Supervisor', 'idle', NOW - 5_000)), roomPending: { count: 2, oldestMinutes: 14 } }),
}

test('the pane flags a session whose room instructions wait past the receipt threshold (#24b)', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home/test' })
  on('fs.exists', () => ({ value: true }))
  on('fs.list', () => ({ value: Object.keys(RECEIPT_FILES).map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }))
  on('fs.read', (_$, e) => ({ value: RECEIPT_FILES[e.path.split('/').at(-1) ?? ''] ?? '' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  await $.command.run({ command: 'crew', args: '' } as never)

  const ui = await $.ui.mount({
    plugin: 'crew', surface: 'terminal', component: 'Pane', requestId: 'crew',
    props: { title: 'Crew', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  expect(await ui.find({ text: /room: 2 pending >10m/ })).toBeDefined()
})
