// bin/crew's liveness for an OpenCode member (crew-code#18 fold-in, found by Raf): a fresh beat is not enough,
// because a member that exited before writing an offline beat would block its own relaunch for 10 minutes. An
// OpenCode member is live only while a process with its CREW_NAME runs. Run:
// node --test hosts/opencode/launcher.node-test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CREW = join(import.meta.dirname, '..', '..', 'bin', 'crew')

const home = (agent: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-launcher-'))
  mkdirSync(join(dir, '.claude', 'sessions'), { recursive: true })
  mkdirSync(join(dir, '.claude', 'crew'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'sessions', 'ROLE_Ceres.md'), '# Ceres\n')
  const beat = { sessionId: 'ses_gone', name: 'Ceres', state: 'idle', agent, beatAt: Date.now() }
  writeFileSync(join(dir, '.claude', 'crew', 'ses_gone.json'), JSON.stringify(beat))
  return dir
}
const stateOf = (dir: string) => {
  const out = execFileSync('bash', [CREW, 'ls'], { env: { ...process.env, HOME: dir, CREW_DRY_RUN: '1' }, encoding: 'utf8' })
  return out.split('\n').find(line => line.startsWith('Ceres'))?.split(/\s+/)[1]
}

test('an OpenCode member with a fresh beat but no running process is not live', () => {
  assert.equal(stateOf(home('opencode')), 'offline')
})

test('the same beat is live while an opencode process with that CREW_NAME runs', async () => {
  // A stand-in process whose command line names opencode, started for Ceres.
  const proc = spawn('bash', ['-c', 'exec -a opencode sleep 30'], { env: { ...process.env, CREW_NAME: 'Ceres' }, stdio: 'ignore' })
  try {
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(stateOf(home('opencode')), 'live')
  } finally {
    proc.kill()
  }
})

test('a Claude member\'s fresh beat stays live by the beat alone, as before', () => {
  assert.equal(stateOf(home('claude')), 'live')
})
