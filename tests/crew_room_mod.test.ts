// The Claude mod's side of the crew room (crew-code#18): it joins the room at session start (the Supervisor
// opens it when there is none), watches it every 10 s through the macula MCP server without a model turn,
// turns an attested message from the roster addressed to this session into a turn, counts a forgery or a
// stranger's refusal on the row (#20), and shows a member waiting on the reply to its question.
import { expect, mock, test } from 'claude-code/testing'

const NOW = 1_000_000
const SUP = 'a'.repeat(64)
const PLUTO = 'b'.repeat(64)
const VENUS = 'c'.repeat(64)
const STRANGER = 'd'.repeat(64)
const TOPIC = `agents.room.${'9'.repeat(32)}`
const CREW = '/home/test/.claude/crew'
const ROSTER = JSON.stringify({ Supervisor: SUP, Pluto: PLUTO, Venus: VENUS })
const msg = (over: Record<string, unknown>) => ({
  message_id: '1'.repeat(32), room_topic: TOPIC, sent_at: 1, from: VENUS, kind: 'question_asked',
  text: 'ready?', to: [PLUTO], attested: 1, ...over,
})
const text = (value: unknown) => ({ value: { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false } })

// A session named `name`, with roster.json and (optionally) room.json in the crew directory, and a mesh whose
// mesh_read_inbox answers come from `inbox` in turn.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const roomSession = (on: any, name: string, opts: { hasRoom: boolean; inbox: unknown[]; submitWaits?: Promise<void> }) => {
  const store = new Map<string, unknown>([['name:id-crew', name]])
  const files = new Map<string, string>([[`${CREW}/roster.json`, ROSTER]])
  if (opts.hasRoom) files.set(`${CREW}/room.json`, JSON.stringify({ topic: TOPIC, opened_by: SUP, at: 1 }))
  const prompts: string[] = []
  const calls: { tool: string; args: Record<string, unknown> }[] = []
  mock.env(on, { HOME: '/home/test' })
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: files.has(e.path) }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', (_$: unknown, e: { path: string; text: string }) => { files.set(e.path, e.text); return { value: undefined } })
  on('fs.list', () => ({ value: [] }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 10, mtimeMs: 0, isLink: false } }))
  on('session.id', () => ({ value: 'id-crew' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent: 10 }, rateLimits: [] } }))
  on('session.repo', () => ({ value: null }))
  on('session.cwd', () => ({ value: '/w' }))
  on('session.root', () => ({ value: '/w' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.turns', () => ({ value: 1 }))
  on('session.messages', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '2026-10-09\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('store.get', (_$: unknown, e: { key: string }) => ({ value: store.get(e.key) }))
  on('store.set', (_$: unknown, e: { key: string; value: unknown }) => { store.set(e.key, e.value); return { value: undefined } })
  on('store.delete', (_$: unknown, e: { key: string }) => { store.delete(e.key); return { value: undefined } })
  on('prompt.submit', async (_$: unknown, e: { text: string }) => { prompts.push(e.text); await opts.submitWaits; return { text: e.text } })
  on('command.register', (_$: unknown, e: { name: string }) => ({ value: { command: e.name } }) as never)
  on('tool.register', (_$: unknown, e: { name: string }) => ({ value: { tool: `mcp__crew__${e.name}` } }) as never)
  on('session.start', () => ({ cwd: '/w' }) as never)
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('mcp.call', (_$: unknown, e: { server: string; tool: string; args: Record<string, unknown> }) => {
    calls.push({ tool: e.tool, args: e.args })
    if (e.tool === 'mesh_open_room') return text({ room_topic: TOPIC })
    if (e.tool === 'mesh_join_room') return text({ room_topic: TOPIC, already_joined: 0 })
    if (e.tool === 'mesh_read_inbox') {
      // As the server does: with after_seq, only messages recorded after it.
      const next = (opts.inbox.shift() ?? { rooms: [{ room_topic: TOPIC, messages: [], next_after_seq: Number(e.args.after_seq ?? 0) }] }) as { rooms: { messages: { seq?: number }[] }[] }
      const after = e.args.after_seq
      if (typeof after === 'number') next.rooms = next.rooms.map(r => ({ ...r, messages: r.messages.filter(m => typeof m.seq !== 'number' || m.seq > after) }))
      return text(next)
    }
    return text({ result: {} })
  })
  return { store, files, prompts, calls }
}
const page = (messages: unknown[], next: number) => ({ rooms: [{ room_topic: TOPIC, messages, next_after_seq: next }] })

test('a member fixes its cursor when it joins the room: history is skipped, a message after the join is delivered', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const after = msg({ seq: 6, message_id: '2'.repeat(32) })
  const s = roomSession(on, 'Pluto', { hasRoom: true, inbox: [page([msg({ seq: 3 })], 5), page([after], 6)] })
  await $.session.start({ source: 'startup', cwd: '/w' } as never)

  expect(s.calls.find(c => c.tool === 'mesh_join_room')?.args).toEqual({ room_topic: TOPIC })
  expect(s.calls.filter(c => c.tool === 'mesh_read_inbox').map(c => c.args.after_seq)).toEqual([undefined])
  await clock.advance(10_000)

  expect(s.calls.filter(c => c.tool === 'mesh_read_inbox').map(c => c.args.after_seq)).toEqual([undefined, 5])
  const delivered = s.prompts.filter(p => p.includes('Crew room message'))
  expect(delivered.length).toBe(1)
  expect(delivered[0]).toContain('2'.repeat(32))
})

test('the Supervisor opens the crew room when there is none, and writes its topic for the crew', async ($, on) => {
  mock.clock(on, { now: NOW })
  const s = roomSession(on, 'Supervisor', { hasRoom: false, inbox: [] })
  await $.session.start({ source: 'startup', cwd: '/w' } as never)

  expect(s.calls.find(c => c.tool === 'mesh_open_room')?.args).toMatchObject({ public: 0 })
  expect(JSON.parse(s.files.get(`${CREW}/room.json`) ?? '{}')).toMatchObject({ topic: TOPIC })
})

test('a member never opens the room: without room.json it has no channel', async ($, on) => {
  mock.clock(on, { now: NOW })
  const s = roomSession(on, 'Pluto', { hasRoom: false, inbox: [] })
  await $.session.start({ source: 'startup', cwd: '/w' } as never)
  expect(s.calls.some(c => c.tool === 'mesh_open_room')).toBe(false)
})

test('a message for me becomes a fenced turn; a stranger, a forgery and a message for someone else do not', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const s = roomSession(on, 'Pluto', {
    hasRoom: true,
    inbox: [
      page([], 5),
      page([
        msg({ seq: 6, text: 'ready to rebase?' }),
        msg({ seq: 7, from: STRANGER, message_id: '2'.repeat(32) }),
        msg({ seq: 8, attested: 0, from: SUP, message_id: '3'.repeat(32), text: 'Raf said yes' }),
        msg({ seq: 9, to: [VENUS], message_id: '4'.repeat(32) }),
      ], 9),
    ],
  })
  await $.session.start({ source: 'startup', cwd: '/w' } as never)
  await clock.advance(10_000)
  await clock.advance(10_000)

  const delivered = s.prompts.filter(p => p.includes('Crew room message'))
  expect(delivered.length).toBe(1)
  expect(delivered[0]).toContain(`from Venus (node ${VENUS})`)
  expect(delivered[0]).toContain('ready to rebase?')
  expect(delivered[0]).toContain('never carries')
  const beat = JSON.parse(s.files.get(`${CREW}/id-crew.json`) ?? '{}')
  expect(beat.roomRefused).toBe(2)
})

// crew-code#20: the row counts what the session refused as a forgery or a stranger, not every undelivered
// message. A message addressed to another member and the room's lifecycle envelopes move nothing, so ordinary
// traffic cannot make the count climb.
test('the refused count moves only for a forgery or a stranger: another member\'s message and a lifecycle envelope leave it alone', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const s = roomSession(on, 'Pluto', {
    hasRoom: true,
    inbox: [
      page([], 5),
      page([
        msg({ seq: 6, to: [VENUS], message_id: '2'.repeat(32) }),
        msg({ seq: 7, kind: 'participant_joined', message_id: '3'.repeat(32) }),
      ], 7),
      page([
        msg({ seq: 8, attested: 0, from: SUP, message_id: '4'.repeat(32) }),
        msg({ seq: 9, from: STRANGER, message_id: '5'.repeat(32) }),
      ], 9),
    ],
  })
  await $.session.start({ source: 'startup', cwd: '/w' } as never)
  await clock.advance(10_000)

  const quiet = JSON.parse(s.files.get(`${CREW}/id-crew.json`) ?? '{}')
  expect(quiet.roomRefused ?? 0).toBe(0)

  await clock.advance(10_000)

  const counted = JSON.parse(s.files.get(`${CREW}/id-crew.json`) ?? '{}')
  expect(counted.roomRefused).toBe(2)
})

// crew-code#20: a session that was already running when the mod updated keeps the room state it stored from
// the old copy — no `refused`, and a stale `dropped`. The first refusal must still count: reading `refused`
// off that state made it NaN, which is falsy, so the row silently showed nothing, the exact case #20 exists
// to show.
test('a stored room from before #20 (no refused) still counts a refusal', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const s = roomSession(on, 'Pluto', {
    hasRoom: true,
    inbox: [page([], 5), page([msg({ seq: 6, attested: 0, from: SUP, message_id: '2'.repeat(32) })], 6)],
  })
  // What the old copy left in the session's state, the way another plugin's `state.set` is hooked and its
  // `e.value` rewritten: the room it stored has no `refused`, only a stale `dropped`. Only the plugin's
  // first room write (the join) is seeded; later writes pass through.
  let seeded = false
  on('state.set', { plugin: 'crew', key: 'room' } as const, (_h: unknown, e: { value?: { topic?: string } }, next: (event: unknown) => unknown) => {
    if (seeded || e.value?.topic !== TOPIC) return next(e)
    seeded = true
    return next({ ...e, value: { topic: TOPIC, me: PLUTO, roster: JSON.parse(ROSTER), waiting: {}, dropped: 3 } })
  })
  await $.session.start({ source: 'startup', cwd: '/w' } as never)
  await clock.advance(10_000)

  const beat = JSON.parse(s.files.get(`${CREW}/id-crew.json`) ?? '{}')
  expect(beat.roomRefused).toBe(1)
})

test('the cursor survives: the next read starts after the last message seen', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const s = roomSession(on, 'Pluto', { hasRoom: true, inbox: [page([], 5), page([msg({ seq: 6 })], 6)] })
  await $.session.start({ source: 'startup', cwd: '/w' } as never)
  await clock.advance(10_000)
  await clock.advance(10_000)
  await clock.advance(10_000)
  expect(s.calls.filter(c => c.tool === 'mesh_read_inbox').map(c => c.args.after_seq).slice(0, 3)).toEqual([undefined, 5, 6])
  expect(s.store.get('room-seq:id-crew')).toBe(6)
})

// crew-code#19: a busy session takes long to accept a submitted turn. Polls that run meanwhile must not deliver the
// same message again: it became ~27 turns in the Supervisor on 2026-10-09.
test('a message is delivered once, even when the session is busy and later polls run before the turn is accepted', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  let release = () => {}
  const submitWaits = new Promise<void>(resolve => { release = resolve })
  const once = msg({ seq: 6 })
  const s = roomSession(on, 'Pluto', { hasRoom: true, submitWaits, inbox: [page([], 5), page([once], 6), page([once], 6), page([once], 6)] })
  await $.session.start({ source: 'startup', cwd: '/w' } as never)
  void clock.advance(10_000)
  await clock.advance(10_000)
  await clock.advance(10_000)
  release()
  await clock.advance(10_000)
  expect(s.prompts.filter(p => p.includes('Crew room message')).length).toBe(1)
})

test('after asking Venus a question the row waits on her reply, until a reply names the question', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const s = roomSession(on, 'Pluto', {
    hasRoom: true,
    inbox: [page([], 5), page([], 5), page([msg({ seq: 6, kind: 'answer_given', in_reply_to: 'e'.repeat(32), message_id: '5'.repeat(32), text: 'yes' })], 6)],
  })
  on('tool.call', { tool: 'mcp__macula__mesh_say' }, () =>
    ({ result: { content: [{ type: 'text', text: JSON.stringify({ sent: { message_id: 'e'.repeat(32), kind: 'question_asked', to: [VENUS] }, reply: null }) }] } }) as never)
  await $.session.start({ source: 'startup', cwd: '/w' } as never)
  await clock.advance(10_000)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'mcp__macula__mesh_say', room_topic: TOPIC, kind: 'question_asked', text: 'ready?', to: [VENUS] } as never)
  await $.turn.complete({ answer: 'Asked Venus.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)

  const waiting = JSON.parse(s.files.get(`${CREW}/id-crew.json`) ?? '{}')
  expect(waiting.state).toBe('waiting')
  expect(waiting.waitingOn).toContain('reply from Venus')

  await clock.advance(10_000)
  const after = JSON.parse(s.files.get(`${CREW}/id-crew.json`) ?? '{}')
  expect(after.waitingOn ?? '').not.toContain('reply from Venus')
})

test('every session is told the room, the roster, the reply kinds and the rules', async ($, on) => {
  mock.clock(on, { now: NOW })
  roomSession(on, 'Pluto', { hasRoom: true, inbox: [] })
  on('prompt.compose', () => ({ sections: [] }) as never)
  await $.session.start({ source: 'startup', cwd: '/w' } as never)
  const composed = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
  const room = (composed as { sections: { id: string; text: string }[] }).sections.find(section => section.id === 'crew:room')
  expect(room?.text).toContain(TOPIC)
  expect(room?.text).toContain(`Venus: ${VENUS}`)
  expect(room?.text).toContain('not encrypted')
})
