// reviewing: a turn runs a review (a reviewer subagent or a review skill, or a phase the member declared),
// or a reviewer still runs in the background after it. working: a turn runs. needs-you: Raf must answer (AskUserQuestion, a permission dialog,
// a closing question). waiting: the turn ended with work still in hand (an unfinished
// reported task, background work, a scheduled wake-up). idle: nothing in hand.
export type CrewState = 'working' | 'reviewing' | 'needs-you' | 'waiting' | 'idle' | 'offline'

// Work still in flight when the turn ended, as the session's Stop hook reported it. A background
// subagent the session's agent list knew then carries its `agentId`, so its end is seen while idle.
export type CrewBackground = { label: string; agentId?: string }
export type CrewPending = { background: CrewBackground[]; wakeups: number }

export type CrewProgress = {
  task: string
  step: number
  of: number
  source: 'report' | 'tasks'
  at: number
}

export type CrewTask = { subject: string; status: 'pending' | 'in_progress' | 'completed' }

export type CrewRefreshPhase = 'none' | 'due' | 'handover' | 'clearing'

export type CrewRefreshFlow = { phase: CrewRefreshPhase; requestedAt: number; name: string; path: string; isForced: boolean; isLimit: boolean }

// `fromPercent`: the context a recent refresh started from, so the row can show the drop (absent in older beats).
export type CrewRefresh = { threshold: number; isAuto: boolean; isPackage?: boolean; refreshedAt: number | null; phase: CrewRefreshPhase; fromPercent?: number }

// The card this session claimed and its context then, until it is finished.
export type CrewCardStart = { cardId: string; issueRef: string; percent: number }

export type CrewBeat = {
  sessionId: string
  name: string
  state: CrewState
  repo: string
  model: string
  turns: number
  contextPercent: number | null
  costUsd: number | null
  fiveHourPercent: number | null
  lastTool: string
  lastLine: string
  waitingOn?: string
  progress: CrewProgress | null
  refresh: CrewRefresh | null
  // The issue of the card this member holds on the board, or '' (absent in beats from older mods).
  card?: string
  // Parked with /crew-park: wake-on-idle leaves this member alone (absent in beats from older mods).
  isParked?: boolean
  // The account's weekly window as this session last read it (seven_day): percent used, reset (ms).
  weekly?: CrewWeekly | null
  // Why the session runs on another model than its own, '' when it runs on its own (#17).
  modelWhy?: string
  // Crew room messages this session refused: a forgery (the station does not attest its sender) or a
  // stranger's (a sender not on the roster). Its own, another member's and lifecycle envelopes are not
  // counted (#20; named roomDropped before it).
  roomRefused?: number
  startedAt: number
  beatAt: number
}

// The crew's one goal as the board holds it (mcl-kanban get_goal): the sentence, the work packages
// it covers, who adopted it and when (ms). `error` names why the last read failed, '' when it worked.
export type CrewWeekly = { percent: number; resetsAt: number }

export type CrewGoal = { goal: string; packages: string[]; by: string; at: number }
export type CrewGoalView = { goal: CrewGoal | null; error: string }

declare module 'claude-code' {
  interface PluginState {
    crew: {
      beats: CrewBeat[]
      me: CrewBeat | null
      reported: CrewProgress | null
      tasks: Record<string, CrewTask>
      refresh: CrewRefreshFlow
      activeAt: number
      pending: CrewPending
      wakes: number
      wokenAt: number
      boardEmptyAt: number
      cardStart: CrewCardStart | null
      goal: CrewGoalView
      // Routine asks queued for the owner (files under the crew directory's asks/), as last counted.
      asks: number
      // The crew room (#18): its topic, this session's node id, the roster, what it waits on (message id -> who),
      // and how many messages it refused as a forgery or a stranger (core/crew_room.ts decides; #20).
      room: { topic: string; me: string; roster: Record<string, string>; waiting: Record<string, string>; refused: number }
    }
  }
}
