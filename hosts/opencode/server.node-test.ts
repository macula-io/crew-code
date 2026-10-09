// Tests for the OpenCode plugin's server part (not *.test.ts: those are the Claude plugin's tests, which
// `claude plugin test` loads). Two faults found live on 2026-10-09:
//
//   #22  OpenCode evicts a location and boots the plugin again in the same process (OpenCode's log:
//        "location services evicted" / "booted" / "loading plugin", every 20-60 minutes on an idle
//        member). The reloaded plugin started with empty state: it never adopted the member's existing
//        session, so `current` stayed '' and no room message was delivered; its room cursor restarted at
//        MAX(id), skipping the gap; and the old instance's teardown marked the member offline although
//        the process lives.
//   #21  crew_park, crew_log, report_progress and queue_ask returned "Tool result declared output
//        without an output schema": a tool with no output schema must return `content`, never `output`.
//
// Run: node --experimental-strip-types --test hosts/opencode/server.node-test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isoWeek } from './beat.ts'
import { start, type RoomSource } from './server.ts'
import type { TranscriptRow } from './room.ts'

const SID = 'ses_probe0000000000000000000'
const ME = 'a'.repeat(64)
const THEM = 'b'.repeat(64)
const SUPERVISOR_ID = 'c'.repeat(64)
const TOPIC = `agents.room.${'9'.repeat(32)}`
const ROSTER = { Probe: ME, Vesta: THEM, Supervisor: SUPERVISOR_ID }

// A transcript row the crew room rules accept: the station attests the sender (`publisher` equals the
// envelope's `from`), the sender is on the roster and the message is addressed to this member.
const row = (id: number, over: Record<string, unknown> = {}): TranscriptRow => ({
  id,
  publisher: THEM,
  raw_json: JSON.stringify({
    message_id: String(id).padStart(32, '0'), room_topic: TOPIC, sent_at: id, from: THEM, to: [ME],
    kind: 'task_handed_over', text: `message ${id}`, ...over,
  }),
})

// A member that already ran: its beat names its session (there is no session listing in OpenCode 2.0.24's
// plugin context, so the crew's own record is what setup adopts).
const crewDirWith = (beat = true) => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-oc-'))
  writeFileSync(join(dir, 'roster.json'), JSON.stringify(ROSTER))
  writeFileSync(join(dir, 'room.json'), JSON.stringify({ topic: TOPIC }))
  if (beat) writeFileSync(join(dir, `${SID}.json`), JSON.stringify({ sessionId: SID, name: 'Probe', state: 'idle', agent: 'opencode', beatAt: Date.now() }))
  return dir
}

const memorySource = () => {
  const rows: TranscriptRow[] = []
  let maxCalls = 0
  const source: RoomSource & { add: (r: TranscriptRow) => void; maxCalls: () => number } = {
    max: async () => { maxCalls += 1; return rows.reduce((n, r) => Math.max(n, r.id), 0) },
    rows: async (_topic, afterId) => rows.filter(r => r.id > afterId).sort((a, b) => a.id - b.id),
    add: (r) => void rows.push(r),
    maxCalls: () => maxCalls,
  }
  return source
}

const fakeCtx = (prompts: { sessionID: string; text: string }[]) => {
  const tools: Record<string, { execute: (input: unknown, context: { sessionID: string }) => Promise<Record<string, unknown>> }> = {}
  return {
    location: { directory: tmpdir() },
    event: { subscribe: () => (async function* () {})() },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        if (sessionID !== SID) throw new Error('Session.NotFoundError')
        return { id: SID }
      },
      prompt: async (input: { sessionID: string; text: string }) => { prompts.push(input); return {} },
      hook: async () => ({}),
    },
    model: { list: async () => [] },
    tool: {
      transform: async (edit: (editor: { add: (tool: { name: string }) => void }) => void) => {
        edit({ add: (tool) => { tools[tool.name] = tool as never } })
        return { dispose: async () => {} }
      },
    },
    tools,
  }
}

const options = (dir: string, source: RoomSource) => ({
  crewDir: dir, name: 'Probe', supervisor: 'Supervisor', roomSource: source, roomPollMs: 10, beatMs: 1000,
})

const until = async (ok: () => boolean, ms = 2000) => {
  const deadline = Date.now() + ms
  while (!ok()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('an idle member adopts its existing session on setup and receives an addressed room message (#22)', async (t) => {
  const dir = crewDirWith()
  const source = memorySource()
  const prompts: { sessionID: string; text: string }[] = []
  const teardown = await start(fakeCtx(prompts), options(dir, source))
  t.after(async () => { await teardown?.() })
  // The fresh member fixed its cursor at MAX before any row: nothing is replayed.
  await until(() => source.maxCalls() > 0)
  source.add(row(1, { text: 'take this' }))
  await until(() => prompts.length > 0)
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].sessionID, SID)
  assert.match(prompts[0].text, /take this/)
  assert.match(prompts[0].text, /Crew room message from Vesta/)
})

test('a message that arrives while the plugin is reloaded is delivered exactly once (#22)', async (t) => {
  const dir = crewDirWith()
  const source = memorySource()
  // A row already present when the member joins: its cursor starts at MAX, so this is not replayed.
  source.add(row(1))

  const first: { sessionID: string; text: string }[] = []
  const stopFirst = await start(fakeCtx(first), options(dir, source))
  t.after(async () => { await stopFirst?.() })
  await until(() => source.maxCalls() > 0)
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(first.length, 0, 'a fresh member does not replay the room history')
  await stopFirst?.()

  // OpenCode evicts and reboots the plugin; a message arrives across the gap.
  source.add(row(2, { text: 'during the gap' }))
  const second: { sessionID: string; text: string }[] = []
  const stopSecond = await start(fakeCtx(second), options(dir, source))
  t.after(async () => { await stopSecond?.() })
  await until(() => second.length > 0)
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(second.length, 1, 'the gap message is delivered once, not twice')
  assert.match(second[0].text, /during the gap/)
})

test('a plugin reload does not mark the member offline; only process exit does (#22)', async (t) => {
  const dir = crewDirWith()
  const prompts: { sessionID: string; text: string }[] = []
  const teardown = await start(fakeCtx(prompts), options(dir, memorySource()))
  t.after(async () => { await teardown?.() })
  await until(() => existsSync(join(dir, `${SID}.json`)))
  await teardown?.()
  const beat = JSON.parse(readFileSync(join(dir, `${SID}.json`), 'utf8')) as { state: string; name: string }
  assert.equal(beat.name, 'Probe')
  assert.notEqual(beat.state, 'offline')
})

test('the crew tools return the field OpenCode accepts for a tool with no output schema, and crew_log lands (#21)', async (t) => {
  const dir = crewDirWith()
  const ctx = fakeCtx([])
  const teardown = await start(ctx, options(dir, memorySource()))
  t.after(async () => { await teardown?.() })
  const call = async (name: string, input: Record<string, unknown>) => {
    const tool = ctx.tools[name]
    assert.ok(tool, `${name} is registered`)
    return tool.execute(input, { sessionID: SID })
  }
  const calls: [string, Record<string, unknown>][] = [
    ['report_progress', { task: 'fix the schema', step: 1, of: 2 }],
    ['crew_park', { parked: 0, reason: 'test' }],
    ['crew_log', { package: 'macula-io/crew-code#21', event: 'checkpoint', note: 'seen red' }],
    ['queue_ask', { ask: 'Delete the reload branch?' }],
  ]
  for (const [name, input] of calls) {
    const result = await call(name, input)
    assert.ok(!('output' in result), `${name} must not return output without an output schema`)
    assert.equal(typeof result.content, 'string', `${name} returns content`)
  }
  // The crew_log line reaches the ledger the owner reads.
  const ledger = join(dir, 'ledger', isoWeek(Date.now()), `${SID}.jsonl`)
  await until(() => existsSync(ledger))
  const line = JSON.parse(readFileSync(ledger, 'utf8').trim().split('\n').at(-1)!) as { event: string; package: string; name: string }
  assert.equal(line.event, 'checkpoint')
  assert.equal(line.package, 'macula-io/crew-code#21')
  assert.equal(line.name, 'Probe')
})
