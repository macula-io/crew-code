// crew-code#24 (a): bin/crew's headless member lifecycle. A member starts in a detached tmux session
// from any shell (no kitty), `crew ls` shows its live agent and macula-mcp process counts, `crew stop`
// kills exactly its own process group, and `crew restart` brings it back. This runs the real launcher
// and a real tmux session against a throwaway member name in a scratch HOME: the stub agent starts a
// stub macula-mcp child, so the whole process tree must come and go without touching any other process
// (a bystander sleep proves stop is not a broad kill).
//
// Run: node --experimental-strip-types --test hosts/opencode/lifecycle.node-test.ts
// It needs tmux and bash on PATH; it skips with that reason otherwise.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CREW = join(import.meta.dirname, '..', '..', 'bin', 'crew')
const NAME = 'LifecycleProbe'
const TMUX_SESSION = `crew-${NAME.toLowerCase()}`

const missing = ['tmux', 'bash'].filter((tool) => spawnSync('sh', ['-c', `command -v ${tool}`]).status !== 0)
const skip = missing.length === 0 ? false : `needs ${missing.join(', ')} on PATH`

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const until = async (ok: () => boolean, what: string, ms = 15_000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (ok()) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error(`timed out waiting for ${what}`)
}

const pidIn = (path: string) => {
  try {
    return Number(readFileSync(path, 'utf8').trim())
  } catch {
    return 0
  }
}

test('a headless member starts, stops and restarts by process group, and ls counts it (#24)', { skip }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'crew-lifecycle-'))
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  const stubs = join(root, 'stubs')
  const tmuxDir = join(root, 'tmux')
  for (const dir of [join(home, '.claude', 'sessions'), bin, stubs, tmuxDir]) mkdirSync(dir, { recursive: true })
  // The throwaway member is on this scratch home's roster only: the real roster is never touched.
  writeFileSync(join(home, '.claude', 'sessions', `ROLE_${NAME}.md`), `# ${NAME}\n`)

  // The stub agent: claude's shape, with a macula-mcp child and pids on disk, then it waits.
  const agentPid = join(stubs, 'agent.pid')
  const maculaPid = join(stubs, 'macula.pid')
  writeFileSync(join(bin, 'claude'), `#!/bin/bash\n"${bin}/macula-mcp" &\necho $! > "${maculaPid}"\necho $$ > "${agentPid}"\nwait\n`)
  writeFileSync(join(bin, 'macula-mcp'), '#!/bin/bash\nsleep 600\n')
  // No mesh work here: a failing npx makes write_roster skip the node ids (it warns), keeping the
  // lifecycle test offline and its starts fast.
  writeFileSync(join(bin, 'npx'), '#!/bin/bash\nexit 1\n')
  chmodSync(join(bin, 'claude'), 0o755)
  chmodSync(join(bin, 'macula-mcp'), 0o755)
  chmodSync(join(bin, 'npx'), 0o755)

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    SHELL: '/bin/bash',
    CREW_AGENT: 'claude',
    CREW_WORKDIR: home,
    CREW_DRY_RUN: '',
    // Its own tmux server, so a stale or foreign one cannot answer for this test.
    TMUX_TMPDIR: tmuxDir,
  }
  const crew = (...args: string[]) => execFileSync('bash', [CREW, ...args], { env, encoding: 'utf8', timeout: 60_000 })
  const tmuxHasSession = () => spawnSync('tmux', ['has-session', '-t', TMUX_SESSION], { env }).status === 0
  // crew ls line for the member: NAME STATE AGENT MACULA ...
  const lsRow = () => crew('ls').split('\n').find((line) => line.startsWith(`${NAME} `))?.trim().split(/\s+/) ?? []
  const counts = () => {
    const row = lsRow()
    return { state: row[1], agents: row[2], maculas: row[3] }
  }

  const bystander = spawn('sleep', ['600'])
  t.after(() => {
    try { crew('stop', NAME) } catch {}
    try { spawnSync('tmux', ['kill-server'], { env }) } catch {}
    try { bystander.kill() } catch {}
    rmSync(root, { recursive: true, force: true })
  })

  // Start: a detached tmux session with the agent and its macula child, its own process group.
  const started = crew('start', NAME)
  assert.match(started, /started headless in tmux session/)
  await until(() => existsSync(agentPid) && existsSync(maculaPid), 'the stub agent and its macula child')
  const first = { agent: pidIn(agentPid), macula: pidIn(maculaPid) }
  assert.equal(alive(first.agent), true, 'the agent runs')
  assert.equal(alive(first.macula), true, 'the macula child runs')
  assert.equal(tmuxHasSession(), true, 'the tmux session exists')
  assert.deepEqual(counts(), { state: 'running', agents: '1', maculas: '1' })

  // Starting again leaves the running member alone.
  assert.match(crew('start', NAME), /already running/)
  assert.equal(pidIn(agentPid), first.agent)

  // Stop: the member's own process group only; the bystander is not in it.
  assert.match(crew('stop', NAME), /stopped/)
  await until(() => !alive(first.agent) && !alive(first.macula), 'the member tree to go')
  assert.equal(alive(bystander.pid!), true, 'stop killed no process outside the member')
  assert.equal(tmuxHasSession(), false, 'the tmux session is gone')
  assert.deepEqual(counts(), { state: 'never', agents: '0', maculas: '0' })
  assert.match(crew('stop', NAME), /not running/)

  // Restart from stopped: a new process tree, the old one stays gone.
  assert.match(crew('restart', NAME), /started headless in tmux session/)
  await until(() => existsSync(agentPid) && pidIn(agentPid) !== 0 && pidIn(agentPid) !== first.agent, 'the restarted agent')
  const second = { agent: pidIn(agentPid), macula: pidIn(maculaPid) }
  await until(() => alive(second.agent) && alive(second.macula) && second.macula !== first.macula, 'the restarted tree')
  await until(() => alive(second.agent) && alive(second.macula) && second.macula !== first.macula, 'the restarted tree')
  assert.deepEqual(counts(), { state: 'running', agents: '1', maculas: '1' })
  assert.match(crew('stop', NAME), /stopped/)
  await until(() => !alive(second.agent) && !alive(second.macula), 'the restarted tree to go')
})
