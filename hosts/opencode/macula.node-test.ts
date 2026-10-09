// crew-code#23: an OpenCode member runs exactly one macula-mcp for its life, however many directories
// (locations) the process touches, so its identity holds one stable station link instead of several
// processes flapping each other off it.
//
// OpenCode connects MCP servers per location, and it boots a location for every directory it resolves
// (a session tab it restores, a project a request names). The launcher's config ships the macula entry
// disabled and the plugin enables it in the directory the member was started in (CREW_WORKDIR) only.
// This runs a real `opencode` through the whole story: a location boot, a second directory, and a
// reload. It asserts one live stub macula server at each point, and that a room message arriving after
// the reload is delivered into the member's session (the #22 path: the reloaded plugin adopts the
// member session its beat names and resumes the room cursor it persisted).
//
// Run: node --experimental-strip-types --test hosts/opencode/macula.node-test.ts
// It needs the OpenCode 2 binary on PATH. CI has none (v2 is not on npm; anomalyco/opencode's public
// releases stop at v1.18.35), so there it skips with that reason.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CREW = join(import.meta.dirname, '..', '..', 'bin', 'crew')
const NODE = process.execPath

// The member and the fixtures. Synthetic ids only, like the #22 tests: the roster is the trust anchor,
// and the station attests the sender by `publisher`.
const ME = 'a'.repeat(64)
const THEM = 'b'.repeat(64)
const SUPERVISOR_ID = 'c'.repeat(64)
const SID = 'ses_probe0000000000000000000'
const TOPIC = `agents.room.${'9'.repeat(32)}`
const ROSTER = { Scout: ME, Vesta: THEM, Supervisor: SUPERVISOR_ID }

const opencodeVersion = (() => {
  try {
    return execFileSync('opencode', ['--version'], { encoding: 'utf8', timeout: 15_000 }).trim()
  } catch {
    return ''
  }
})()
const skip = /v2\.\d/.test(opencodeVersion)
  ? false
  : `needs the OpenCode 2 binary on PATH (opencode --version said '${opencodeVersion || 'nothing'}'); anomalyco/opencode ships v2 only to package managers, not npm, so CI has none`

// The stub macula server: records its spawn and exit with pid and cwd, answers the MCP handshake, and
// idles. Never touches the mesh: the test must not put real presence behind a member identity.
const STUB = `#!/usr/bin/env node
const fs = require('fs')
const LOG = process.env.STUB_LOG
const rec = (o) => { try { fs.appendFileSync(LOG, JSON.stringify(o) + '\\n') } catch {} }
rec({ event: 'spawn', pid: process.pid, cwd: process.cwd(), at: Date.now() })
const bye = () => { rec({ event: 'exit', pid: process.pid, at: Date.now() }); process.exit(0) }
process.on('SIGTERM', bye)
process.on('SIGINT', bye)
process.stdin.on('end', bye)
process.stdin.on('close', bye)
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let index
  while ((index = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, index)
    buf = buf.slice(index + 1)
    if (!line.trim()) continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
    if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub-macula', version: '0' } } })
    else if (message.method === 'tools/list') send({ jsonrpc: '2.0', id: message.id, result: { tools: [] } })
    else if (message.method === 'ping') send({ jsonrpc: '2.0', id: message.id, result: {} })
    else if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'no such method' } })
  }
})
`

const envelope = (id: number, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    message_id: String(id).padStart(32, '0'), room_topic: TOPIC, sent_at: id, from: THEM, to: [ME],
    kind: 'task_handed_over', text: `message ${id}`, ...over,
  })

// The launcher's own config for this member: the crew plugin directory under test and the macula entry
// as it ships. The command is swapped for the stub so no real macula-mcp ever runs.
const memberConfig = (work: string) => {
  const out = execFileSync('bash', [CREW, 'Scout'], {
    env: { ...process.env, HOME: work, CREW_DRY_RUN: '1', CREW_AGENT: 'opencode', CREW_WORKDIR: work },
    encoding: 'utf8',
    timeout: 120_000,
  })
  const line = out.split('\n').find((row) => row.startsWith('[here]')) ?? ''
  const config = JSON.parse(execFileSync('bash', ['-c',
    'eval "a=($1)"; for x in "${a[@]}"; do [[ $x == OPENCODE_CONFIG_CONTENT=* ]] && printf %s "${x#*=}"; done; true',
    '_', line.replace(/^\[here\] cd \S+ &&/, '')], { encoding: 'utf8' })) as {
    mcp: { macula: { command: string[]; environment: Record<string, string>; disabled?: boolean } }
  }
  config.mcp.macula.command = [NODE, join(work, 'stub-macula.js')]
  config.mcp.macula.environment = { MACULA_MCP_AGENT: 'probe' }
  return config
}

const until = async (ok: () => boolean, what: string, ms: number) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (ok()) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error(`timed out waiting for ${what}`)
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('stub-macula')
  } catch {
    return true
  }
}

test('two location boots and a reload leave exactly one macula-mcp, and the room still reaches the member (#23)', { skip }, async (t) => {
  let DatabaseSync: typeof import('node:sqlite').DatabaseSync
  try {
    ;({ DatabaseSync } = await import('node:sqlite'))
  } catch {
    t.skip('node:sqlite is not available in this node')
    return
  }

  const root = mkdtempSync(join(tmpdir(), 'crew-23-'))
  const home = join(root, 'home')
  const work = join(root, 'work')
  const other = join(root, 'other')
  const crewDir = join(root, 'crew')
  const transcript = join(root, 'transcript.sqlite3')
  const stubLog = join(root, 'stub.log')
  const debugLog = join(root, 'debug.log')
  for (const dir of [home, work, other, crewDir, join(crewDir, 'opencode')]) mkdirSync(dir, { recursive: true })

  // The stub as the member's macula server.
  writeFileSync(join(work, 'stub-macula.js'), STUB)
  // The crew state the plugin reads: the roster (its trust anchor), the room, and the member's beat,
  // which names the session a reload must adopt (#22).
  writeFileSync(join(crewDir, 'roster.json'), JSON.stringify(ROSTER))
  writeFileSync(join(crewDir, 'room.json'), JSON.stringify({ topic: TOPIC }))
  writeFileSync(join(crewDir, `${SID}.json`), JSON.stringify({ sessionId: SID, name: 'Scout', state: 'idle', agent: 'opencode', beatAt: Date.now() }))
  // The transcript: row 1 predates the member, so its cursor fixes at MAX and replays nothing.
  const db = new DatabaseSync(transcript)
  db.exec('CREATE TABLE observed_facts (id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT NOT NULL, sender TEXT, text TEXT, raw_json TEXT NOT NULL, observed_at TEXT NOT NULL, publisher TEXT, message_id TEXT)')
  db.prepare('INSERT INTO observed_facts (topic, raw_json, publisher, observed_at) VALUES (?, ?, ?, ?)').run(TOPIC, envelope(1), THEM, new Date().toISOString())
  db.close()

  const password = `pw-${Math.random().toString(36).slice(2)}`
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    OPENCODE_PASSWORD: password,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(memberConfig(work)),
    CREW_NAME: 'Scout',
    CREW_SUPERVISOR: 'Supervisor',
    CREW_DIR: crewDir,
    CREW_WORKDIR: work,
    MACULA_MCP_LOBBY_TRANSCRIPT_DB: transcript,
    STUB_LOG: stubLog,
    CREW_DEBUG: debugLog,
  }

  const serve = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let serveOut = ''
  serve.stdout?.on('data', (chunk) => { serveOut += String(chunk) })
  serve.stderr?.on('data', (chunk) => { serveOut += String(chunk) })

  const spawnLogs = () => {
    try {
      return readFileSync(stubLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { event: string; pid: number; cwd: string }).filter((entry) => entry.event === 'spawn')
    } catch {
      return [] as { event: string; pid: number; cwd: string }[]
    }
  }
  const liveStubs = () => spawnLogs().filter((entry) => alive(entry.pid))
  // The count must settle: after a reload the old stub exits and a new one spawns; only a stable
  // reading means what the member runs.
  const settledStubs = async (ms = 60_000) => {
    const deadline = Date.now() + ms
    let previous = -1
    let stableSince = 0
    while (Date.now() < deadline) {
      const count = liveStubs().length
      const now = Date.now()
      if (count !== previous) {
        previous = count
        stableSince = now
      } else if (count > 0 && now - stableSince >= 1200) return count
      await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    }
    return liveStubs().length
  }

  const api = (...args: string[]) => execFileSync('opencode', ['api', '--server', baseUrl(), ...args], { env, encoding: 'utf8', timeout: 60_000 })
  let url = ''
  const baseUrl = () => {
    if (!url) {
      const match = serveOut.match(/server listening on (http:\/\/\S+)/)
      if (!match) throw new Error(`no server URL yet: ${serveOut.slice(-400)}`)
      url = match[1]
    }
    return url
  }

  const cleanup = () => {
    try { serve.kill('SIGTERM') } catch {}
    for (const entry of spawnLogs()) {
      try { process.kill(entry.pid, 'SIGTERM') } catch {}
    }
    try { rmSync(root, { recursive: true, force: true }) } catch {}
  }
  t.after(cleanup)

  try {
    await until(() => /server listening on/.test(serveOut), 'opencode serve', 90_000)

    // Location one: the member's own directory, from its very first request.
    api('mcp.list')
    // The member session the beat names, so a reload has something to adopt.
    api('session.create', '-d', JSON.stringify({ id: SID, location: { directory: work } }))
    // The plugin fixed its room cursor at the row that predates the member: nothing is replayed.
    await until(() => existsSync(join(crewDir, 'opencode', 'room-Scout.json')), 'the room cursor', 30_000)
    assert.equal(await settledStubs(), 1, 'the member runs one macula-mcp in its own directory')

    // Location two: a second directory the process resolves. On the bug this boots a second macula-mcp.
    api('mcp.list', '--param', `location[directory]=${other}`)
    assert.equal(await settledStubs(), 1, 'a second location adds no second macula-mcp')
    assert.equal(spawnLogs().some((entry) => entry.cwd === other), false, 'no macula-mcp ever starts in the other directory')

    // Reload: every location is evicted and rebuilt (#22). A room message arriving now must still reach
    // the member: the reloaded plugin adopts the beat's session and resumes its cursor.
    execFileSync('opencode', ['reload', '--server', baseUrl()], { env, encoding: 'utf8', timeout: 60_000 })
    const db2 = new DatabaseSync(transcript)
    db2.prepare('INSERT INTO observed_facts (topic, raw_json, publisher, observed_at) VALUES (?, ?, ?, ?)').run(TOPIC, envelope(2, { text: 'across the gap' }), THEM, new Date().toISOString())
    db2.close()
    const cursor = () => JSON.parse(readFileSync(join(crewDir, 'opencode', 'room-Scout.json'), 'utf8')) as { cursor: number }
    await until(() => cursor().cursor >= 2, 'the room message delivered after the reload', 90_000)
    assert.equal(cursor().cursor, 2, 'only the message after the reload was delivered, once')
    assert.equal(await settledStubs(), 1, 'the reloaded location still runs exactly one macula-mcp')

    // The delivery reached the session itself, not just the cursor, and exactly once: every location
    // boots another plugin instance, and a row must not become a turn per instance (#19).
    const messages = api('GET', `/api/session/${SID}/message`)
    assert.equal((messages.match(/across the gap/g) ?? []).length, 1)
  } catch (error) {
    let debug = ''
    try { debug = readFileSync(debugLog, 'utf8').split('\n').slice(-30).join('\n') } catch {}
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n--- serve:\n${serveOut.slice(-1500)}\n--- plugin trace:\n${debug}`)
  }
})
