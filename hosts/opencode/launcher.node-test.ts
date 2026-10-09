// bin/crew's liveness for an OpenCode member (crew-code#18 fold-in, found by Raf): a fresh beat is not enough,
// because a member that exited before writing an offline beat would block its own relaunch for 10 minutes. An
// OpenCode member is live only while a process with its CREW_NAME runs. Run:
// node --test hosts/opencode/launcher.node-test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A dry run goes through write_roster, which would run `npx macula-mcp-node-id` and download the package
// into each scratch HOME (about 130 MB per run: leftover scratch homes had filled /tmp). A failing npx
// on PATH keeps these tests offline and tiny; the node ids are skipped, with a warning, as they are
// when npx cannot reach npm (#24).
const stubBin = mkdtempSync(join(tmpdir(), 'crew-test-bin-'))
writeFileSync(join(stubBin, 'npx'), '#!/bin/bash\nexit 1\n')
chmodSync(join(stubBin, 'npx'), 0o755)
process.on('exit', () => { try { rmSync(stubBin, { recursive: true, force: true }) } catch {} })
process.env.PATH = `${stubBin}:${process.env.PATH}`

const CREW = join(import.meta.dirname, '..', '..', 'bin', 'crew')

const home = (agent: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-launcher-'))
  mkdirSync(join(dir, '.claude', 'sessions'), { recursive: true })
  mkdirSync(join(dir, '.claude', 'crew'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'sessions', 'ROLE_Probe.md'), '# Probe\n')
  const beat = { sessionId: 'ses_gone', name: 'Probe', state: 'idle', agent, beatAt: Date.now() }
  writeFileSync(join(dir, '.claude', 'crew', 'ses_gone.json'), JSON.stringify(beat))
  return dir
}
const stateOf = (dir: string) => {
  const out = execFileSync('bash', [CREW, 'ls'], { env: { ...process.env, HOME: dir, CREW_DRY_RUN: '1' }, encoding: 'utf8' })
  return out.split('\n').find(line => line.startsWith('Probe'))?.split(/\s+/)[1]
}

test('an OpenCode member with a fresh beat but no running process is not live', () => {
  assert.equal(stateOf(home('opencode')), 'offline')
})

test('the same beat is live while an opencode process with that CREW_NAME runs', async () => {
  // A stand-in process whose command line names opencode, started for Probe.
  const proc = spawn('bash', ['-c', 'exec -a opencode sleep 30'], { env: { ...process.env, CREW_NAME: 'Probe' }, stdio: 'ignore' })
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
// complete entry, which replaces the global one: the crew's macula-mcp release, keyed by the member's name. It
// ships disabled (#23): OpenCode connects MCP servers per location, so the plugin enables it in the member's own
// directory only, and the launcher passes that directory as CREW_WORKDIR.
const openCodeLaunch = (dir: string) => {
  const out = execFileSync('bash', [CREW, 'Probe'], { env: { ...process.env, HOME: dir, CREW_DRY_RUN: '1', CREW_AGENT: 'opencode' }, encoding: 'utf8' })
  return out.split('\n').find(line => line.startsWith('[here]')) ?? ''
}
const openCodeConfig = (launch: string) => {
  const unquoted = execFileSync('bash', ['-c', 'eval "a=($1)"; for x in "${a[@]}"; do [[ $x == OPENCODE_CONFIG_CONTENT=* ]] && printf %s "${x#*=}"; done; true', '_', launch.replace(/^\[here\] cd \S+ &&/, '')], { encoding: 'utf8' })
  return JSON.parse(unquoted)
}

test('an OpenCode member runs its own macula server, keyed by its name, shipped disabled for the plugin to scope (#23)', () => {
  const dir = home('opencode')
  const launch = openCodeLaunch(dir)
  assert.match(launch, /CREW_WORKDIR=/)
  const macula = openCodeConfig(launch).mcp.macula
  assert.equal(macula.type, 'local')
  assert.deepEqual(macula.command.slice(-3), ['-p', '@macula-io/mcp@0.46.1', 'macula-mcp'])
  assert.deepEqual(macula.environment, { MACULA_MCP_AGENT: 'probe' })
  assert.equal(macula.disabled, true, 'the plugin enables it in the member\'s own directory only')
})

// A mixed crew in one command (Raf, 2026-10-09): a member whose member_models entry is an OpenCode model
// (provider/model) runs on OpenCode on that model, with no CREW_AGENT; `crew up <Name...>` brings up only those.
const mixedHome = () => {
  const dir = home('opencode')
  writeFileSync(join(dir, '.claude', 'sessions', 'ROLE_Mars.md'), '# Mars\n')
  const options = { member_models: 'Probe:deepseek/deepseek-v4-pro, Mars:claude-sonnet-5-5' }
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ pluginConfigs: { crew: { options } } }))
  return dir
}
const dryRun = (dir: string, args: string[]) =>
  execFileSync('bash', [CREW, ...args], { env: { ...process.env, HOME: dir, CREW_DRY_RUN: '1', CREW_AGENT: '' }, encoding: 'utf8' })

test('a member whose model is provider/model runs on OpenCode on that model, without CREW_AGENT', () => {
  const launch = dryRun(mixedHome(), ['Probe']).split('\n').find(line => line.startsWith('[here]')) ?? ''
  assert.match(launch, /opencode --standalone/)
  assert.match(launch, /deepseek\/deepseek-v4-pro/)
})

test('a member whose model is a Claude model still runs on claude', () => {
  const launch = dryRun(mixedHome(), ['Mars']).split('\n').find(line => line.startsWith('[here]')) ?? ''
  assert.match(launch, / claude --model claude-sonnet-5-5 /)
})

test('crew up with names brings up only those members, each on its own agent', () => {
  const tabs = dryRun(mixedHome(), ['up', 'Probe']).split('\n').filter(line => line.startsWith('[tab]'))
  assert.equal(tabs.length, 1)
  assert.match(tabs[0], /CREW_NAME=Probe/)
  assert.match(tabs[0], /opencode --standalone/)
})
