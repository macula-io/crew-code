// The OpenCode adapter's pure part: from OpenCode's bus events to the crew state each member
// session is in, and the beat (types/index.d.ts CrewBeat) the dashboard reads. No I/O here, so the
// rules are tested with node --test; server.ts feeds it events and writes what it returns.

// The states and beat shape are the dashboard's (types/index.d.ts); copied, not imported, so this
// file runs under plain node (the types file declares the Claude engine's module).
export type CrewState = 'working' | 'reviewing' | 'needs-you' | 'waiting' | 'idle' | 'offline'
export type CrewProgress = { task: string; step: number; of: number; source: 'report' | 'tasks'; at: number }

// One root session (a member's conversation). Subagent sessions are folded into their root.
export type Member = {
  sessionId: string
  state: CrewState
  lastLine: string
  lastTool: string
  turns: number
  // Tokens the last model step used (input, output and cache): the context in use.
  contextTokens: number
  progress: CrewProgress | null
  isReviewDeclared: boolean
  // Running subagents of this root that review, by session id.
  reviewers: string[]
  // The state before an owner prompt (permission or form) opened, by its id, to go back to.
  openAsks: Record<string, CrewState>
}

export type Tracker = {
  sessions: Record<string, Member>
  // Subagent session id -> its root, and whether it reviews.
  children: Record<string, { root: string; isReview: boolean }>
}

export type BusEvent = { type: string; data: Record<string, unknown> }

export const fresh = (): Tracker => ({ sessions: {}, children: {} })

// Same rule as the Claude mod (hooks/register.tsx isReviewText): a subagent reviews when its agent
// or its title names a review or an attack.
export const isReviewText = (text: string) => /review|adversar/i.test(text)

const text = (value: unknown, max = 160) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

const member = (sessionId: string): Member => ({
  sessionId, state: 'idle', lastLine: '', lastTool: '', turns: 0, contextTokens: 0, progress: null,
  isReviewDeclared: false, reviewers: [], openAsks: {},
})

// The state a running turn shows, given what is open in it.
const runningState = (m: Member): CrewState =>
  m.reviewers.length > 0 || m.isReviewDeclared ? 'reviewing' : 'working'

const withMember = (tracker: Tracker, id: string, change: (m: Member) => Member): Tracker => {
  const held = tracker.sessions[id]
  return held ? { ...tracker, sessions: { ...tracker.sessions, [id]: change(held) } } : tracker
}

// The member session an event belongs to: itself, or the root of the subagent it came from.
const rootOf = (tracker: Tracker, id: string) => tracker.children[id]?.root ?? id

const openAsk = (tracker: Tracker, sessionID: string, askId: string, line: string) =>
  withMember(tracker, rootOf(tracker, sessionID), m => ({
    ...m,
    openAsks: { ...m.openAsks, [askId]: m.state === 'needs-you' ? 'working' : m.state },
    state: 'needs-you',
    lastLine: line,
  }))

const closeAsk = (tracker: Tracker, sessionID: string, askId: string) =>
  withMember(tracker, rootOf(tracker, sessionID), m => {
    const { [askId]: before, ...rest } = m.openAsks
    const isStillAsking = Object.keys(rest).length > 0
    return { ...m, openAsks: rest, state: isStillAsking ? 'needs-you' : before ?? runningState(m) }
  })

const clampProgress = (data: Record<string, unknown>): CrewProgress => {
  const of = Math.max(1, Math.floor(Number(data.of) || 1))
  return {
    task: String(data.task ?? '').slice(0, 80),
    step: Math.min(of, Math.max(0, Math.floor(Number(data.step) || 0))),
    of,
    source: 'report',
    at: Number(data.at) || 0,
  }
}

// One event in, the tracker after it. Unknown events change nothing. `crew.progress` is the
// adapter's own event (report_progress), so the tool's effect follows the same rules.
export const apply = (tracker: Tracker, event: BusEvent): Tracker => {
  const d = event.data ?? {}
  const id = String(d.sessionID ?? '')
  switch (event.type) {
    case 'session.created': {
      const parent = d.parentID ? String(d.parentID) : ''
      if (!parent) return tracker.sessions[id] ? tracker : { ...tracker, sessions: { ...tracker.sessions, [id]: member(id) } }
      const root = rootOf(tracker, parent)
      const isReview = isReviewText(`${text(d.agent)} ${text(d.title)}`)
      return { ...tracker, children: { ...tracker.children, [id]: { root, isReview } } }
    }
    case 'session.deleted': {
      const { [id]: _gone, ...sessions } = tracker.sessions
      const { [id]: _child, ...children } = tracker.children
      return { sessions, children }
    }
    case 'session.execution.started': {
      const child = tracker.children[id]
      if (child) {
        return child.isReview
          ? withMember(tracker, child.root, m => ({ ...m, reviewers: [...new Set([...m.reviewers, id])], state: m.state === 'needs-you' ? m.state : 'reviewing' }))
          : tracker
      }
      return withMember(tracker, id, m => ({ ...m, turns: m.turns + 1, state: runningState(m), lastLine: '', lastTool: '', openAsks: {} }))
    }
    case 'session.execution.succeeded':
    case 'session.execution.failed':
    case 'session.execution.interrupted': {
      const child = tracker.children[id]
      if (child) {
        return withMember(tracker, child.root, m => {
          const reviewers = m.reviewers.filter(r => r !== id)
          const next = { ...m, reviewers }
          return m.state === 'reviewing' && !m.isReviewDeclared && reviewers.length === 0 ? { ...next, state: 'working' } : next
        })
      }
      const why =
        event.type === 'session.execution.failed' ? `failed: ${text((d.error as { message?: unknown } | undefined)?.message ?? d.error)}`
        : event.type === 'session.execution.interrupted' ? `interrupted: ${text(d.reason)}`
        : undefined
      // As in the Claude mod: a turn that ends on a question is waiting on the owner.
      return withMember(tracker, id, m => ({
        ...m,
        state: !why && m.lastLine.endsWith('?') ? 'needs-you' : 'idle',
        isReviewDeclared: false, reviewers: [], openAsks: {}, lastLine: why ?? m.lastLine,
      }))
    }
    case 'permission.asked':
      return openAsk(tracker, id, `permission:${text(d.id)}`, `permission for ${text(d.action) || 'a tool'}`)
    case 'permission.replied':
      return closeAsk(tracker, id, `permission:${text(d.requestID)}`)
    case 'form.created': {
      const form = (d.form ?? {}) as Record<string, unknown>
      return openAsk(tracker, String(form.sessionID ?? ''), `form:${text(form.id)}`, text(form.title) || 'answer the question')
    }
    case 'form.replied':
    case 'form.cancelled':
      return closeAsk(tracker, id, `form:${text(d.id)}`)
    case 'session.text.ended': {
      // Only the member's own answer, not a subagent's.
      if (tracker.children[id]) return tracker
      const line = String(d.text ?? '').split('\n').map(part => part.trim()).filter(Boolean).at(-1)
      return line ? withMember(tracker, id, m => ({ ...m, lastLine: line.slice(0, 160) })) : tracker
    }
    case 'session.step.ended': {
      if (tracker.children[id]) return tracker
      const t = (d.tokens ?? {}) as { input?: number; output?: number; cache?: { read?: number; write?: number } }
      const used = (t.input ?? 0) + (t.output ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
      return used > 0 ? withMember(tracker, id, m => ({ ...m, contextTokens: used })) : tracker
    }
    case 'crew.progress':
      return withMember(tracker, rootOf(tracker, id), m => {
        const phase = d.phase === 'reviewing' || d.phase === 'working' ? d.phase : undefined
        const isReviewDeclared = phase ? phase === 'reviewing' : m.isReviewDeclared
        const running = m.state === 'working' || m.state === 'reviewing'
        const next = { ...m, progress: clampProgress(d), isReviewDeclared }
        return running ? { ...next, state: runningState(next) } : next
      })
    default:
      return tracker
  }
}

export type Usage = { model: string; costUsd: number | null; contextPercent: number | null }

// The beat the dashboard reads, unchanged in shape; `agent` says which coding agent wrote it.
export const beatOf = (
  m: Member,
  at: { name: string; repo: string; isParked: boolean; now: number; startedAt: number; usage: Usage },
) => ({
  sessionId: m.sessionId,
  name: at.name,
  state: m.state,
  repo: at.repo,
  model: at.usage.model,
  turns: m.turns,
  contextPercent: at.usage.contextPercent,
  costUsd: at.usage.costUsd,
  // OpenCode reports no account rate windows.
  fiveHourPercent: null,
  weekly: null,
  lastTool: m.lastTool,
  lastLine: m.lastLine,
  waitingOn: '',
  progress: m.progress,
  refresh: null,
  card: '',
  isParked: at.isParked,
  agent: 'opencode',
  startedAt: at.startedAt,
  beatAt: at.now,
})

// The Claude mod's ISO week (hooks/register.tsx isoWeek), so both write one ledger.
export const isoWeek = (at: number) => {
  const day = new Date(at)
  const date = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()))
  const weekday = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - weekday)
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1)
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7)
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

// One ledger line, in the Claude mod's LedgerEvent shape.
export const ledgerLine = (entry: { event: string; package?: string; note?: string }, name: string, at: number, cost: number | null) =>
  JSON.stringify({ ...entry, name, at, cost, weekly: null })

// Where an OpenCode member's park flag lives (the Claude mod keeps its own in the engine's store).
export const parkPath = (crewDir: string, name: string) => `${crewDir}/opencode/park-${name}`

export const SUPERVISOR_EVENTS = ['assigned', 'ask_sent', 'owner_yes', 'sent_back', 'live', 'closed']
export const MEMBER_EVENTS = ['checkpoint', 'release', 'fix_after_ship', 'fable_round']
export const LOG_EVENTS = [...SUPERVISOR_EVENTS, ...MEMBER_EVENTS]
export const PACKAGE_REF = /^[\w.-]+\/[\w.-]+#\d+$/
