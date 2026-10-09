// Tests for the OpenCode plugin's server part (not *.test.ts: those are the Claude plugin's tests, which
// `claude plugin test` loads). Faults found live on 2026-10-09:
//
//   #19  a room row reached an OpenCode member up to three times: every OpenCode location boots another
//        plugin instance, each with its own in-memory cursor, and each delivered rows the others did
//        too. The room is delivered from the member's own location only, and a per-message claim file
//        keeps delivery idempotent where instances overlap.
//   #22  OpenCode evicts a location and boots the plugin again in the same process (OpenCode's log:
//        "location services evicted" / "booted" / "loading plugin", every 20-60 minutes on an idle
//        member). The reloaded plugin started with empty state: it never adopted the member's existing
//        session, so `current` stayed '' and no room message was delivered; its room cursor restarted at
//        MAX(id), skipping the gap; and the old instance's teardown marked the member offline although
//        the process lives.
//   #21  crew_park, crew_log, report_progress and queue_ask returned "Tool result declared output
//        without an output schema": a tool with no output schema must return `content`, never `output`.
//   #23  OpenCode connects MCP servers per location: every directory a member's process resolves ran
//        another macula-mcp under its identity, and the copies flapped each other off the station. The
//        launcher ships the entry disabled; setup enables it in the member's own directory only.
//
// Run: node --experimental-strip-types --test hosts/opencode/server.node-test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
    // The member's own location, resolved as the plugin resolves it (CREW_WORKDIR, else the process
    // cwd): room delivery is scoped to it (#19).
    location: { directory: process.env.CREW_WORKDIR?.trim() || process.cwd() },
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

// crew-code#23: OpenCode connects MCP servers per location, so the macula entry ships disabled and setup
// enables it in the member's own directory (CREW_WORKDIR, else the process cwd) only: a second location
// drops it instead of spawning a second macula-mcp under the same identity.
test('macula is enabled in the member\'s own directory and left out of every other location (#23)', async (t) => {
  const dir = crewDirWith()
  const applied: string[] = []
  const withMcp = (directory: string) => {
    const ctx = fakeCtx([])
    return {
      ...ctx,
      location: { directory },
      mcp: {
        transform: async (edit: (editor: {
          update: (name: string, update: (config: { disabled?: boolean }) => void) => void
          remove: (name: string) => void
        }) => void) => {
          let enabled = false
          let removed = false
          edit({
            update: (_name, update) => {
              const config: { disabled?: boolean } = { disabled: true }
              update(config)
              enabled = config.disabled === false
            },
            remove: () => { removed = true },
          })
          applied.push(enabled ? 'enabled' : removed ? 'removed' : 'untouched')
        },
      },
    }
  }
  const previous = process.env.CREW_WORKDIR
  process.env.CREW_WORKDIR = '/home/probe'
  t.after(() => {
    if (previous === undefined) delete process.env.CREW_WORKDIR
    else process.env.CREW_WORKDIR = previous
  })

  const homeTeardown = await start(withMcp('/home/probe'), options(dir, memorySource()))
  t.after(async () => { await homeTeardown?.() })
  await until(() => applied.length === 1)
  assert.deepEqual(applied, ['enabled'])

  const otherTeardown = await start(withMcp('/home/probe/other-location'), options(dir, memorySource()))
  t.after(async () => { await otherTeardown?.() })
  await until(() => applied.length === 2)
  assert.deepEqual(applied, ['enabled', 'removed'])
})

// crew-code#19: every location boots another plugin instance; on 2026-10-09 one row reached an OpenCode
// member three times. Each instance keeps its own in-memory cursor, so an instance lagging behind
// delivers rows the instance that owns the member's location already delivered. The room is delivered
// from the member's own location only (the one that also runs its macula server, #23).
test('a second instance in another location does not deliver the room row again (#19)', async (t) => {
  const dir = crewDirWith()
  const source = memorySource()
  const previous = process.env.CREW_WORKDIR
  process.env.CREW_WORKDIR = '/home/probe'
  t.after(() => {
    if (previous === undefined) delete process.env.CREW_WORKDIR
    else process.env.CREW_WORKDIR = previous
  })
  const home = fakeCtx([])
  const other = fakeCtx([])
  const homePrompts: { text: string }[] = []
  const otherPrompts: { text: string }[] = []
  home.session.prompt = async (input: { text: string }) => { homePrompts.push(input); return {} }
  other.session.prompt = async (input: { text: string }) => { otherPrompts.push(input); return {} }
  home.location = { directory: '/home/probe' }
  other.location = { directory: '/home/probe/other' }
  const stopHome = await start(home, options(dir, source))
  const stopOther = await start(other, options(dir, source))
  t.after(async () => { await stopHome?.(); await stopOther?.() })
  // Both instances are live before the row exists (the home one fixes its cursor; on the bug both do).
  await new Promise(resolve => setTimeout(resolve, 300))
  source.add(row(2, { text: 'the go' }))
  await until(() => homePrompts.length > 0)
  // Long enough for the other instance to deliver it too, had nothing stopped it.
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(homePrompts.length, 1, 'the owning location delivers the row once')
  assert.equal(otherPrompts.length, 0, 'the other location delivers nothing')
})

// The backstop where two instances of the same location overlap (a reload booting the replacement before
// the old instance's timers stop): the claim file is the atomic gate, so one row is still one turn.
test('two overlapping instances of one location deliver the room row once (#19)', async (t) => {
  const dir = crewDirWith()
  const source = memorySource()
  const prompts: { text: string }[] = []
  const first = fakeCtx([])
  const second = fakeCtx([])
  first.session.prompt = async (input: { text: string }) => { prompts.push(input); return {} }
  second.session.prompt = async (input: { text: string }) => { prompts.push(input); return {} }
  const stopFirst = await start(first, options(dir, source))
  const stopSecond = await start(second, options(dir, source))
  t.after(async () => { await stopFirst?.(); await stopSecond?.() })
  // Both instances are live and past their first room read before the row exists.
  await new Promise(resolve => setTimeout(resolve, 100))
  source.add(row(2, { text: 'once, however many readers' }))
  await until(() => prompts.length > 0)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(prompts.length, 1, 'one row is one turn')
  assert.equal(existsSync(join(dir, 'opencode', 'delivered', 'Probe', '0'.repeat(31) + '2')), true, 'the claim is on disk')
})

// crew-code#24 (a): the Supervisor restarts members headless. The tool runs `crew restart <name>
// [--fresh]` through the launcher its own launch env names (CREW_BIN) and reports what it said.
test('crew_restart runs the launcher with the member and reports it (#24)', async (t) => {
  const dir = crewDirWith()
  const ctx = fakeCtx([])
  const teardown = await start(ctx, options(dir, memorySource()))
  t.after(async () => { await teardown?.() })
  const tool = ctx.tools['crew_restart']
  assert.ok(tool, 'crew_restart is registered')

  // A stub launcher records the argv it was handed.
  const marker = join(dir, 'restart-args.txt')
  const stub = join(dir, 'fake-crew.sh')
  writeFileSync(stub, `#!/bin/bash\nprintf '%s\\n' "$@" > "${marker}"\necho "Probe: stopped"\necho "Probe: started headless in tmux session crew-probe"\n`)
  chmodSync(stub, 0o755)
  const previous = process.env.CREW_BIN
  process.env.CREW_BIN = stub
  t.after(() => {
    if (previous === undefined) delete process.env.CREW_BIN
    else process.env.CREW_BIN = previous
  })

  const result = await tool.execute({ name: 'Venus', reason: 'stalled', fresh: 1 }, { sessionID: SID })
  assert.match(String(result.content), /Venus restarted fresh/)
  assert.match(String(result.content), /started headless/)
  assert.deepEqual(readFileSync(marker, 'utf8').trim().split('\n'), ['restart', 'Venus', '--fresh'])
  const bad = await tool.execute({ name: 'not a name', reason: 'x', fresh: 0 }, { sessionID: SID })
  assert.match(String(bad.content), /Not restarted/)
})

// #24 follow-up, found live: a superseded session deleted from the store kept a beat ticking, because a
// late event from its stale TUI tab re-adopted it (session.get fails, and the old adopt still created the
// member), and the 20s beat loop never asked whether the session still existed.
test('a session the store no longer has is not adopted, so no ghost beat (#24 follow-up)', async (t) => {
  const dir = crewDirWith()
  const ctx = fakeCtx([])
  // One late event for a session the store no longer has, as a stale tab emits: the subscription ends
  // with it, so only the plugin's own work is under test.
  ctx.event.subscribe = () => (async function* () {
    yield { type: 'session.text.ended', data: { sessionID: 'ses_gone000000000000000000000', text: 'ghost' } }
  })()
  const teardown = await start(ctx, options(dir, memorySource()))
  t.after(async () => { await teardown?.() })

  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(existsSync(join(dir, 'ses_gone000000000000000000000.json')), false, 'no beat for a session the store does not have')
})

test('a beat is reaped within a beat when its session is gone, and not rewritten (#24 follow-up)', async (t) => {
  const dir = crewDirWith()
  let alive = true
  const ctx = fakeCtx([])
  ctx.session.get = async ({ sessionID }: { sessionID: string }) => {
    if (!alive || sessionID !== SID) throw new Error('Session.NotFoundError')
    return { id: SID }
  }
  const teardown = await start(ctx, options(dir, memorySource()))
  t.after(async () => { await teardown?.() })
  await until(() => existsSync(join(dir, `${SID}.json`)), 3000)
  alive = false
  await until(() => !existsSync(join(dir, `${SID}.json`)), 3000)
  await new Promise(resolve => setTimeout(resolve, 1200))
  assert.equal(existsSync(join(dir, `${SID}.json`)), false, 'and it is not rewritten')
})

test('a beat whose session is gone is reaped at setup (#24 follow-up)', async (t) => {
  const dir = crewDirWith()
  writeFileSync(join(dir, 'ses_gone000000000000000000000.json'), JSON.stringify({ sessionId: 'ses_gone000000000000000000000', name: 'Probe', state: 'idle', agent: 'opencode', beatAt: Date.now() - 1000 }))
  const teardown = await start(fakeCtx([]), options(dir, memorySource()))
  t.after(async () => { await teardown?.() })
  await until(() => !existsSync(join(dir, 'ses_gone000000000000000000000.json')), 3000)
})
