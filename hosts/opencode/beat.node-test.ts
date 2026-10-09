// Tests for the OpenCode adapter's pure part: which crew state an OpenCode event puts a member in,
// and the beat it writes. Run: node --test hosts/opencode/beat.node-test.ts (not *.test.ts: those are the
// Claude plugin's tests, which `claude plugin test` loads).
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply, beatOf, fresh, isoWeek, ledgerLine, parkPath, type Tracker } from './beat.ts'

const ROOT = 'ses_root'
const CHILD = 'ses_child'
const ev = (type: string, data: Record<string, unknown>) => ({ type, data })
const run = (events: { type: string; data: Record<string, unknown> }[], from: Tracker = fresh()) =>
  events.reduce((tracker, event) => apply(tracker, event), from)
const stateOf = (tracker: Tracker) => tracker.sessions[ROOT]?.state

test('a turn starting is working, and its end is idle', () => {
  const started = run([ev('session.created', { sessionID: ROOT }), ev('session.execution.started', { sessionID: ROOT })])
  assert.equal(stateOf(started), 'working')
  assert.equal(started.sessions[ROOT]?.turns, 1)
  assert.equal(stateOf(run([ev('session.execution.succeeded', { sessionID: ROOT })], started)), 'idle')
})

test('a failed or interrupted turn ends idle and says why', () => {
  const started = run([ev('session.created', { sessionID: ROOT }), ev('session.execution.started', { sessionID: ROOT })])
  const failed = run([ev('session.execution.failed', { sessionID: ROOT, error: { message: 'rate limited' } })], started)
  assert.equal(stateOf(failed), 'idle')
  assert.match(failed.sessions[ROOT]?.lastLine ?? '', /rate limited/)
  const stopped = run([ev('session.execution.interrupted', { sessionID: ROOT, reason: 'user' })], started)
  assert.equal(stateOf(stopped), 'idle')
  assert.match(stopped.sessions[ROOT]?.lastLine ?? '', /interrupted: user/)
})

test('a permission ask needs the owner, and the reply puts the row back', () => {
  const started = run([ev('session.created', { sessionID: ROOT }), ev('session.execution.started', { sessionID: ROOT })])
  const asked = run([ev('permission.asked', { sessionID: ROOT, id: 'p1', action: 'bash' })], started)
  assert.equal(stateOf(asked), 'needs-you')
  assert.equal(asked.sessions[ROOT]?.lastLine, 'permission for bash')
  assert.equal(stateOf(run([ev('permission.replied', { sessionID: ROOT, requestID: 'p1', reply: 'once' })], asked)), 'working')
})

test('the question tool (a form) needs the owner until it is answered or cancelled', () => {
  const started = run([ev('session.created', { sessionID: ROOT }), ev('session.execution.started', { sessionID: ROOT })])
  const asked = run([ev('form.created', { form: { id: 'f1', sessionID: ROOT, title: 'Push 3 commits?' } })], started)
  assert.equal(stateOf(asked), 'needs-you')
  assert.equal(asked.sessions[ROOT]?.lastLine, 'Push 3 commits?')
  assert.equal(stateOf(run([ev('form.replied', { id: 'f1', sessionID: ROOT, answer: {} })], asked)), 'working')
  assert.equal(stateOf(run([ev('form.cancelled', { id: 'f1', sessionID: ROOT })], asked)), 'working')
})

test('a subagent is not a member: its turns and asks land on the root session', () => {
  const started = run([
    ev('session.created', { sessionID: ROOT }),
    ev('session.execution.started', { sessionID: ROOT }),
    ev('session.created', { sessionID: CHILD, parentID: ROOT, agent: 'general' }),
    ev('session.execution.started', { sessionID: CHILD }),
  ])
  assert.equal(started.sessions[CHILD], undefined)
  assert.equal(stateOf(started), 'working')
  assert.equal(started.sessions[ROOT]?.turns, 1)
  const asked = run([ev('permission.asked', { sessionID: CHILD, id: 'p2', action: 'edit' })], started)
  assert.equal(stateOf(asked), 'needs-you')
})

test('a reviewer subagent makes the row reviewing while it runs, and working after', () => {
  const reviewing = run([
    ev('session.created', { sessionID: ROOT }),
    ev('session.execution.started', { sessionID: ROOT }),
    ev('session.created', { sessionID: CHILD, parentID: ROOT, agent: 'general', title: 'Adversarial review of the adapter' }),
    ev('session.execution.started', { sessionID: CHILD }),
  ])
  assert.equal(stateOf(reviewing), 'reviewing')
  assert.equal(stateOf(run([ev('session.execution.succeeded', { sessionID: CHILD })], reviewing)), 'working')
})

test('a declared review phase holds until working is declared or the turn ends', () => {
  const started = run([ev('session.created', { sessionID: ROOT }), ev('session.execution.started', { sessionID: ROOT })])
  const declared = run([ev('crew.progress', { sessionID: ROOT, task: 'review #11', step: 1, of: 2, phase: 'reviewing', at: 5 })], started)
  assert.equal(stateOf(declared), 'reviewing')
  assert.deepEqual(declared.sessions[ROOT]?.progress, { task: 'review #11', step: 1, of: 2, source: 'report', at: 5 })
  assert.equal(stateOf(run([ev('crew.progress', { sessionID: ROOT, task: 'review #11', step: 2, of: 2, phase: 'working', at: 6 })], declared)), 'working')
  assert.equal(stateOf(run([ev('session.execution.succeeded', { sessionID: ROOT })], declared)), 'idle')
})

test('progress is clamped and the task cut short', () => {
  const started = run([ev('session.created', { sessionID: ROOT })])
  const reported = run([ev('crew.progress', { sessionID: ROOT, task: 'x'.repeat(200), step: 9, of: 3, at: 1 })], started)
  assert.equal(reported.sessions[ROOT]?.progress?.step, 3)
  assert.equal(reported.sessions[ROOT]?.progress?.task.length, 80)
})

test('the last line of the answer is the row\'s line; ending on a question needs the owner', () => {
  const started = run([ev('session.created', { sessionID: ROOT }), ev('session.execution.started', { sessionID: ROOT })])
  const said = run([ev('session.text.ended', { sessionID: ROOT, text: 'Built it.\n\nPush 2 commits to main?' })], started)
  assert.equal(said.sessions[ROOT]?.lastLine, 'Push 2 commits to main?')
  assert.equal(stateOf(said), 'working')
  assert.equal(stateOf(run([ev('session.execution.succeeded', { sessionID: ROOT })], said)), 'needs-you')
  const done = run([ev('session.text.ended', { sessionID: ROOT, text: 'Done.' }), ev('session.execution.succeeded', { sessionID: ROOT })], started)
  assert.equal(stateOf(done), 'idle')
  const fromChild = run([
    ev('session.created', { sessionID: CHILD, parentID: ROOT }),
    ev('session.text.ended', { sessionID: CHILD, text: 'subagent says?' }),
  ], said)
  assert.equal(fromChild.sessions[ROOT]?.lastLine, 'Push 2 commits to main?')
})

test('the tokens of the last step are the context the session uses', () => {
  const started = run([ev('session.created', { sessionID: ROOT }), ev('session.execution.started', { sessionID: ROOT })])
  const stepped = run([ev('session.step.ended', { sessionID: ROOT, tokens: { input: 151, output: 2, reasoning: 8, cache: { read: 7424, write: 0 } } })], started)
  assert.equal(stepped.sessions[ROOT]?.contextTokens, 7577)
  const fromChild = run([
    ev('session.created', { sessionID: CHILD, parentID: ROOT }),
    ev('session.step.ended', { sessionID: CHILD, tokens: { input: 99999 } }),
  ], stepped)
  assert.equal(fromChild.sessions[ROOT]?.contextTokens, 7577)
})

test('a deleted session leaves the tracker', () => {
  const gone = run([ev('session.created', { sessionID: ROOT }), ev('session.deleted', { sessionID: ROOT })])
  assert.equal(gone.sessions[ROOT], undefined)
})

test('events the adapter does not know change nothing', () => {
  const started = run([ev('session.created', { sessionID: ROOT })])
  assert.deepEqual(run([ev('session.text.delta', { sessionID: ROOT, text: 'hi' })], started), started)
})

test('the beat is the dashboard\'s CrewBeat, with usage from the session', () => {
  const started = run([ev('session.created', { sessionID: ROOT }), ev('session.execution.started', { sessionID: ROOT })])
  const beat = beatOf(started.sessions[ROOT]!, {
    name: 'Pluto', repo: 'macula-io/crew-code', isParked: true, now: 50_000, startedAt: 1_000,
    usage: { model: 'deepseek/deepseek-flash', costUsd: 0.01, contextPercent: 12 },
  })
  assert.deepEqual(beat, {
    sessionId: ROOT, name: 'Pluto', state: 'working', repo: 'macula-io/crew-code', model: 'deepseek/deepseek-flash',
    turns: 1, contextPercent: 12, costUsd: 0.01, fiveHourPercent: null, weekly: null, lastTool: '', lastLine: '',
    waitingOn: '', progress: null, refresh: null, card: '', isParked: true, agent: 'opencode', startedAt: 1_000, beatAt: 50_000,
  })
})

test('ledger lines and park files use the Claude mod\'s paths and shapes', () => {
  assert.equal(isoWeek(Date.UTC(2026, 9, 9)), '2026-W41')
  assert.equal(parkPath('/home/x/.claude/crew', 'Pluto'), '/home/x/.claude/crew/opencode/park-Pluto')
  assert.deepEqual(JSON.parse(ledgerLine({ event: 'checkpoint', package: 'macula-io/crew-code#11', note: 'go' }, 'Pluto', 7, 0.5)), {
    event: 'checkpoint', package: 'macula-io/crew-code#11', note: 'go', name: 'Pluto', at: 7, cost: 0.5, weekly: null,
  })
})
