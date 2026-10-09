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

// The member's macula server (Supervisor, Vesta's report): OpenCode drops an inline MCP entry that has no command
// and runs the global one, so every OpenCode member shared the global config's identity. The launcher gives a
// complete entry, which replaces the global one: the crew's macula-mcp release, keyed by the member's name.
const openCodeConfigOf = (dir: string) => {
  const out = execFileSync('bash', [CREW, 'Ceres'], { env: { ...process.env, HOME: dir, CREW_DRY_RUN: '1', CREW_AGENT: 'opencode' }, encoding: 'utf8' })
  const line = out.split('\n').find(line => line.startsWith('[here]')) ?? ''
  const unquoted = execFileSync('bash', ['-c', 'eval "a=($1)"; for x in "${a[@]}"; do [[ $x == OPENCODE_CONFIG_CONTENT=* ]] && printf %s "${x#*=}"; done; true', '_', line.replace(/^\[here\] cd \S+ &&/, '')], { encoding: 'utf8' })
  return JSON.parse(unquoted)
}

test('an OpenCode member runs its own macula server, keyed by its name, whatever the global config holds', () => {
  const macula = openCodeConfigOf(home('opencode')).mcp.macula
  assert.equal(macula.type, 'local')
  assert.deepEqual(macula.command.slice(-3), ['-p', '@macula-io/mcp@0.46.1', 'macula-mcp'])
  assert.deepEqual(macula.environment, { MACULA_MCP_AGENT: 'ceres' })
})

// A mixed crew in one command (Raf, 2026-10-09): a member whose member_models entry is an OpenCode model
// (provider/model) runs on OpenCode on that model, with no CREW_AGENT; `crew up <Name...>` brings up only those.
const mixedHome = () => {
  const dir = home('opencode')
  writeFileSync(join(dir, '.claude', 'sessions', 'ROLE_Mars.md'), '# Mars\n')
  const options = { member_models: 'Ceres:deepseek/deepseek-v4-pro, Mars:claude-sonnet-5-5' }
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ pluginConfigs: { crew: { options } } }))
  return dir
}
const dryRun = (dir: string, args: string[]) =>
  execFileSync('bash', [CREW, ...args], { env: { ...process.env, HOME: dir, CREW_DRY_RUN: '1', CREW_AGENT: '' }, encoding: 'utf8' })

test('a member whose model is provider/model runs on OpenCode on that model, without CREW_AGENT', () => {
  const launch = dryRun(mixedHome(), ['Ceres']).split('\n').find(line => line.startsWith('[here]')) ?? ''
  assert.match(launch, /opencode --standalone/)
  assert.match(launch, /deepseek\/deepseek-v4-pro/)
})

test('a member whose model is a Claude model still runs on claude', () => {
  const launch = dryRun(mixedHome(), ['Mars']).split('\n').find(line => line.startsWith('[here]')) ?? ''
  assert.match(launch, / claude --model claude-sonnet-5-5 /)
})

test('crew up with names brings up only those members, each on its own agent', () => {
  const tabs = dryRun(mixedHome(), ['up', 'Ceres']).split('\n').filter(line => line.startsWith('[tab]'))
  assert.equal(tabs.length, 1)
  assert.match(tabs[0], /CREW_NAME=Ceres/)
  assert.match(tabs[0], /opencode --standalone/)
})
