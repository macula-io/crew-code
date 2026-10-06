// working: a turn runs. needs-you: Raf must answer (AskUserQuestion, a permission dialog,
// a closing question). waiting: the turn ended with work still in hand (an unfinished
// reported task, background work, a scheduled wake-up). idle: nothing in hand.
export type CrewState = 'working' | 'needs-you' | 'waiting' | 'idle' | 'offline'

// Work still in flight when the turn ended, as the session's Stop hook reported it.
export type CrewPending = { background: string[]; wakeups: number }

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

export type CrewRefresh = { threshold: number; isAuto: boolean; isPackage?: boolean; refreshedAt: number | null; phase: CrewRefreshPhase }

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
  startedAt: number
  beatAt: number
}

// The crew's one goal as the board holds it (mcl-kanban get_goal): the sentence, the work packages
// it covers, who adopted it and when (ms). `error` names why the last read failed, '' when it worked.
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
    }
  }
}
