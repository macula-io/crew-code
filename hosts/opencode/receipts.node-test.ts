// crew-code#24b, live: a real Claude member is started through the launcher in a scratch home (the crew
// mod loaded from this checkout, its own macula-mcp identity), a real macula-mcp publishes one room
// message addressed to it, and the member's host must acknowledge the delivery with a `message_delivered`
// receipt fact on the room -- published by the mod through the macula server, no model turn in the loop.
//
// This talks to the real mesh (a throwaway identity and an unguessable room topic), so it is opt-in:
// set CREW_LIVE_RECEIPTS=1. It needs claude, tmux and npx on PATH.
//
// Run: CREW_LIVE_RECEIPTS=1 node --experimental-strip-types --test hosts/opencode/receipts.node-test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dirname, '..', '..')
const CREW = join(REPO, 'bin', 'crew')
const MCP = '@macula-io/mcp@0.46.1'
const TOPIC = `agents.room.${Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('')}`
const MEMBER = 'ReceiptProbe'
const SENDER = 'supervisor'

const missing = ['claude', 'tmux', 'npx', 'sqlite3'].filter((tool) => spawnSync('sh', ['-c', `command -v ${tool}`]).status !== 0)
const skip = process.env.CREW_LIVE_RECEIPTS !== '1'
  ? 'live proof: set CREW_LIVE_RECEIPTS=1 to run it (real claude, real mesh)'
  : missing.length > 0 ? `needs ${missing.join(', ')} on PATH` : false

const until = async (ok: () => boolean, what: string, ms = 120_000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (ok()) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000))
  }
  throw new Error(`timed out waiting for ${what}`)
}

// A node picker that works under a scratch HOME too: some installations front node with a shim that
// needs the real home, so the first candidate that answers --version with HOME=<scratch> wins.
const nodeTool = (scratchHome: string, tool: string) => {
  const candidates = [`/usr/bin/${tool}`, `/usr/local/bin/${tool}`, tool]
  for (const candidate of candidates) {
    const ran = spawnSync(candidate, ['--version'], { env: { ...process.env, HOME: scratchHome }, encoding: 'utf8' })
    if (ran.status === 0) return candidate
  }
  return tool
}

// The receipt fact for `messageId`, as the member's transcript recorded it: raw payload and the
// station-attested publisher.
const receiptOf = (db: string, messageId: string) => {
  const ran = spawnSync('sqlite3', ['-json', db, `SELECT raw_json, publisher FROM observed_facts WHERE topic = '${TOPIC}' AND raw_json LIKE '%message_delivered%'`], { encoding: 'utf8' })
  if (ran.status !== 0) return null
  const rows = JSON.parse(ran.stdout.trim() || '[]') as { raw_json: string; publisher: string }[]
  for (const row of rows) {
    const fact = (JSON.parse(row.raw_json) as { message_delivered?: { message_id?: string } }).message_delivered
    if (fact?.message_id === messageId) return { publisher: row.publisher, fact: fact as { member?: string } }
  }
  return null
}

test('a real Claude member acknowledges a room delivery with a receipt fact (#24b, live)', { skip }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'crew-receipts-'))
  const home = join(root, 'home')
  const work = join(root, 'work')
  const crewDir = join(home, '.claude', 'crew')
  const tmuxDir = join(root, 'tmux')
  for (const dir of [join(home, '.claude', 'mods'), work, crewDir, tmuxDir]) mkdirSync(dir, { recursive: true })
  // The crew mod under test, loaded exactly as a real member loads it.
  symlinkSync(REPO, join(home, '.claude', 'mods', 'crew'))
  const NPX = nodeTool(home, 'npx')
  // A working npx must win inside the member too: some PATH front-runners (version-manager shims) break
  // under a scratch HOME, and the launcher's roster step and the member's macula server both run npx.
  // Only npx is shadowed: a system claude earlier on PATH (an older install) must not take the session.
  const binDir = join(root, 'bin')
  mkdirSync(binDir)
  symlinkSync(NPX, join(binDir, 'npx'))
  const path = `${binDir}:${process.env.PATH}`

  const env = { ...process.env, PATH: path, HOME: home, TMUX_TMPDIR: tmuxDir, SHELL: '/bin/bash', CREW_AGENT: 'claude', CREW_HOLD: '1', CREW_WORKDIR: work }
  const nodeIdOf = (agent: string) =>
    execFileSync(NPX, ['-y', '-p', MCP, 'macula-mcp-node-id'], { env: { ...env, MACULA_MCP_AGENT: agent }, encoding: 'utf8', timeout: 120_000 }).trim()
  const memberNode = nodeIdOf('receiptprobe')
  const senderNode = nodeIdOf(SENDER)
  assert.match(memberNode, /^[0-9a-f]{64}$/, 'the member identity exists')
  assert.match(senderNode, /^[0-9a-f]{64}$/, 'the sender identity exists')

  // The launcher writes the roster itself at start, from the ROLE cards and the pre-created keys: the
  // member's card puts it on the roster, and the sender's identity is the roster's Supervisor.
  mkdirSync(join(home, '.claude', 'sessions'), { recursive: true })
  writeFileSync(join(home, '.claude', 'sessions', `ROLE_${MEMBER}.md`), `# ${MEMBER}\n`)
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
    env: { CLAUDE_CODE_PLUGIN_DIRS: `${home}/.claude/mods/crew` },
    skipDangerousModePermissionPrompt: true,
    pluginConfigs: { crew: { options: { supervisor: 'Supervisor', members: MEMBER, owner: 'Test', board: 'off' } } },
  }))
  writeFileSync(join(home, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true,
    mcpServers: { macula: { command: NPX, args: ['-y', '-p', MCP, 'macula-mcp'] } },
    projects: { [work]: { hasTrustDialogAccepted: true } },
  }))
  writeFileSync(join(crewDir, 'room.json'), JSON.stringify({ topic: TOPIC, opened_by: senderNode, at: Date.now() }))

  // The real sender: one macula-mcp, driven over MCP stdio, publishing the addressed envelope as an
  // integration fact on the room (a fact the room's envelope parser still reads as a message). The same
  // message id is republished on a retry: the same receipt, which is exactly the idempotency asked for.
  const messageId = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  const envelope = { message_id: messageId, room_topic: TOPIC, sent_at: Date.now(), from: senderNode, to: [memberNode], kind: 'task_handed_over', text: 'receipt probe' }
  const publisher = join(root, 'publish.mjs')
  writeFileSync(publisher, `import { spawn } from 'node:child_process'
const [topic, fact] = process.argv.slice(2)
const child = spawn(process.env.NPX_BIN, ['-y', '-p', '${MCP}', 'macula-mcp'], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
let buf = ''
let id = 0
const waiters = new Map()
child.stdout.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    let message; try { message = JSON.parse(line) } catch { continue }
    const waiter = waiters.get(message.id)
    if (waiter) { waiters.delete(message.id); waiter(message) }
  }
})
const call = (method, params) => new Promise((resolve, reject) => {
  const callId = ++id
  waiters.set(callId, resolve)
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: callId, method, params }) + '\\n')
  setTimeout(() => { waiters.delete(callId); reject(new Error('timeout ' + method)) }, 90000)
})
try {
  await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'receipt-probe', version: '0' } })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\\n')
  const result = await call('tools/call', { name: 'mesh_publish', arguments: { topic, fact: JSON.parse(fact) } })
  if (result.error || result.result?.isError) throw new Error(JSON.stringify(result).slice(0, 300))
  child.stdin.end()
  setTimeout(() => process.exit(0), 1500)
} catch (error) {
  console.error(String(error).slice(0, 300))
  process.exit(1)
}
`)
  const publish = () => {
    const ran = spawnSync('node', [publisher, TOPIC, JSON.stringify(envelope)], { env: { ...env, MACULA_MCP_AGENT: SENDER, NPX_BIN: NPX }, encoding: 'utf8', timeout: 150_000 })
    return ran.status === 0
  }

  const crew = (...args: string[]) => execFileSync('bash', [CREW, ...args], { env, encoding: 'utf8', timeout: 120_000 })
  t.after(() => {
    try { crew('stop', MEMBER) } catch {}
    try { spawnSync('tmux', ['kill-server'], { env }) } catch {}
    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  crew('start', MEMBER)
  // The launcher writes the roster from the cards and keys; the mod needs this member on it to join.
  await until(() => {
    try { return new RegExp(`"${MEMBER}": "[0-9a-f]{64}"`).test(readFileSync(join(crewDir, 'roster.json'), 'utf8')) } catch { return false }
  }, 'the member on the launcher-written roster', 30_000)
  // The mod writes a beat as soon as the session starts; only then has it joined the room and is its tap
  // recording. The first publish can still land before the tap is up (observation is never retroactive),
  // which is why a miss is reprinted rather than lost.
  await until(() => existsSync(crewDir) && readdirSync(crewDir).some((entry) => entry.endsWith('.json') && entry !== 'roster.json' && entry !== 'room.json'), 'the member beat (the mod runs)', 150_000)

  const db = join(home, '.macula-mcp', 'lobby-transcript.sqlite3')
  for (let attempt = 0; attempt < 4 && receiptOf(db, messageId) === null; attempt += 1) {
    assert.equal(publish(), true, 'the sender published')
    await until(() => receiptOf(db, messageId) !== null, 'the delivery receipt fact', 45_000).catch(() => undefined)
  }
  const receipt = receiptOf(db, messageId)
  if (!receipt) {
    const rows = spawnSync('sqlite3', [db, `SELECT count(*) FROM observed_facts WHERE topic = '${TOPIC}'`], { encoding: 'utf8' })
    const panes = spawnSync('tmux', ['capture-pane', '-p', '-t', 'crew-receiptprobe'], { env, encoding: 'utf8' })
    console.error('diagnostics: topic rows =', rows.stdout.trim(), '| pane tail:\n', String(panes.stdout).split('\n').slice(-25).join('\n'))
  }
  assert.ok(receipt, 'the member acknowledged the delivery with a receipt fact')
  assert.equal(receipt.publisher, memberNode, 'the receipt is attested by the member identity')
  assert.equal(receipt.fact.member, MEMBER)
})
