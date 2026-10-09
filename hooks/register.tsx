import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { acceptEnvelope, fenceDelivery, nameOf, roomRulesPrompt, waitingOn, type Refusal, type RoomMessage, type Roster, type Waiting } from '../core/crew_room.ts'
import type { CrewBackground, CrewBeat, CrewGoal, CrewGoalView, CrewPending, CrewProgress, CrewRefreshFlow, CrewState, CrewTask, CrewWeekly } from '../types'

const PANE = 'crew'
const BEAT_MS = 20_000
const REFRESH_MS = 5_000
const OFFLINE_AFTER_MS = 90_000
// How long a dead session's last beat keeps its row. About visibility, not liveness: a
// live session rewrites its file every BEAT_MS whether or not a turn runs, so a file
// swept by mistake is back within one beat. Long enough to notice a member went down.
const SWEEP_AFTER_MS = 60 * 60_000
const BAR_CELLS = 14
// The crew, from the plugin's settings (userConfig): who supervises, who the members are, and who
// owns the work (the person whose yes a push needs). Set once per load by register().
let SUPERVISOR = 'Supervisor'
let OWNER = 'the owner'
let ROSTER: string[] = [SUPERVISOR]
// The board: 'mesh' reaches mcl-kanban through the macula MCP server's mesh_call, in REALM (empty is
// the server's default realm); 'off' leaves the board out of prompts, wake-ups and the dashboard.
let BOARD: 'mesh' | 'off' = 'mesh'
let REALM = ''
const namesOf = (text: string) => text.split(',').map(name => name.trim()).filter(Boolean)

const beats = atom({ plugin: 'crew', key: 'beats' } as const, [])
const me = atom({ plugin: 'crew', key: 'me' } as const, null)
const reported = atom({ plugin: 'crew', key: 'reported' } as const, null)
const tasks = atom({ plugin: 'crew', key: 'tasks' } as const, {})
const IDLE_FLOW: CrewRefreshFlow = { phase: 'none', requestedAt: 0, name: '', path: '', isForced: false, isLimit: false }
const refreshFlow = atom({ plugin: 'crew', key: 'refresh' } as const, IDLE_FLOW)

const DEFAULT_THRESHOLD = 40
// Package mode: cards are small and the cards of one work package share code and decisions, so a
// member keeps its context across them and refreshes when the board hands it a card from another
// package. Below PACKAGE_MIN_PERCENT the context is too small to be worth a handover.
const PACKAGE_MIN_PERCENT = 20
const PACKAGE_HANDOVER_NOTE =
  'Crew package mode: this card is from another work package than your last one, so do not start this card. ' +
  'End your turn now: this session hands over and a fresh one finds the card with get_my_cards.'
const AUTO_TASK_PERCENT = 20
const AUTO_IDLE_PERCENT = 15
const AUTO_IDLE_MS = 50 * 60_000
const IDLE_CHECK_MS = 60_000
// A card can use 30 to 40% of context and its size is not known when it is claimed, so no card
// starts at or above the claim limit, and a member hands over at a safe point at the handover
// limit. Both fixed; card-usage.tsv is what tunes them.
const CLAIM_LIMIT = 50
const HANDOVER_LIMIT = 70
// Wake-on-idle: an idle member with nothing in hand is prompted after a pause that doubles with
// every wake that brings it no card, up to WAKE_MAX_MS. A board_empty answer holds wakes off longer.
const WAKE_AFTER_MS = 2 * 60_000
const WAKE_MAX_MS = 30 * 60_000
const BOARD_EMPTY_MS = 30 * 60_000
const MESH_CALL = 'mcp__macula__mesh_call'
const MESH_SAY = 'mcp__macula__mesh_say'
const CLAIMS = ['mcl-kanban/claim_next_card', 'mcl-kanban/claim_card']
const wakes = atom({ plugin: 'crew', key: 'wakes' } as const, 0)
const wokenAt = atom({ plugin: 'crew', key: 'wokenAt' } as const, 0)
const boardEmptyAt = atom({ plugin: 'crew', key: 'boardEmptyAt' } as const, 0)
const cardStart = atom({ plugin: 'crew', key: 'cardStart' } as const, null)
const activeAt = atom({ plugin: 'crew', key: 'activeAt' } as const, 0)
// The crew's one goal lives on the board (kanban#18); the mod reads it over the mesh, through the
// macula MCP server's mesh_call, and never from the board's own storage.
const MESH_SERVER = 'macula'
const GOAL_MS = 5 * 60_000
const NO_GOAL: CrewGoalView = { goal: null, error: '' }
const goalView = atom({ plugin: 'crew', key: 'goal' } as const, NO_GOAL)
const PACKAGE_REF = /^[\w.-]+\/[\w.-]+#\d+$/
const GOAL_USAGE =
  'Usage: /crew-goal shows the crew goal. /crew-goal <one or two work-package refs> <one sentence> sets it, ' +
  'e.g. /crew-goal macula-io/macula#75 A stranger can find an app on the mesh'

const textOf = (blocks: { type: string; text?: string }[]) => blocks.map(block => block.text ?? '').join('\n').trim()

// One board procedure over the mesh: its result, or why it failed in the board's or the mesh's words.
const askBoard = async ($: EngineInterface, procedure: string, args: Record<string, unknown>) => {
  const call = REALM ? { procedure, args, realm: REALM } : { procedure, args }
  const answer = await $.mcp.call(MESH_SERVER, 'mesh_call', call).catch((error: unknown) => ({
    content: [{ type: 'text', text: String(error) }],
    isError: true,
  }))
  const text = textOf(answer.content)
  if (answer.isError) return { error: text || `${procedure} failed` }
  const reply = JSON.parse(text) as { result?: Record<string, unknown> }
  const failed = reply.result?.error
  return failed === undefined ? { result: reply.result ?? {} } : { error: `${procedure}: ${JSON.stringify(failed)}` }
}

// The crew room (#18): one mesh room per crew, its topic in room.json (the Supervisor opens it), the crew's node
// ids in roster.json (bin/crew writes it). Watched every ROOM_POLL_MS through the macula server, no model turn:
// a message is delivered only by core/crew_room.ts's rules (attested, from the roster, addressed here).
const ROOM_POLL_MS = 10_000
type CrewRoom = { topic: string; me: string; roster: Roster; waiting: Waiting; dropped: number }
const NO_ROOM: CrewRoom = { topic: '', me: '', roster: {}, waiting: {}, dropped: 0 }
const crewRoom = atom({ plugin: 'crew', key: 'room' } as const, NO_ROOM)

// One macula MCP tool: its JSON answer, or why it failed.
const askMesh = async ($: EngineInterface, tool: string, args: Record<string, unknown>) => {
  const answer = await $.mcp.call(MESH_SERVER, tool, args).catch((error: unknown) => ({
    content: [{ type: 'text', text: String(error) }],
    isError: true,
  }))
  const text = textOf(answer.content)
  if (answer.isError) return { error: text || `${tool} failed` }
  try {
    return { result: JSON.parse(text) as Record<string, unknown> }
  } catch {
    return { error: `${tool}: ${text.slice(0, 120)}` }
  }
}

const readJsonFile = async ($: EngineInterface, path: string) =>
  (await $.fs.exists(path)) ? (JSON.parse(await $.fs.read(path)) as Record<string, unknown>) : null

// Joins the crew room, opening it first when this is the Supervisor and there is none. No room.json and not
// the Supervisor: no channel (the prompt says so once).
const joinCrewRoom = async ($: EngineInterface) => {
  const dir = await crewDir($)
  const roster = ((await readJsonFile($, `${dir}/roster.json`).catch(() => null)) ?? {}) as Roster
  const name = await currentName($)
  const me = roster[name] ?? ''
  let topic = String((await readJsonFile($, `${dir}/room.json`).catch(() => null))?.topic ?? '')
  if (!topic && name === SUPERVISOR && me) {
    const opened = await askMesh($, 'mesh_open_room', { purpose: 'crew room', public: 0 })
    topic = String(opened.result?.room_topic ?? '')
    if (topic) await $.fs.write(`${dir}/room.json`, JSON.stringify({ topic, opened_by: me, at: await $.clock.now() }))
  }
  if (!topic || !me) return update($, crewRoom, room => ({ ...room, topic: '', me, roster }))
  await askMesh($, 'mesh_join_room', { room_topic: topic })
  return update($, crewRoom, room => ({ ...room, topic, me, roster }))
}

const boundary = () => Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('')

// One read of the crew room after this session's cursor. The first read, right after the join, only sets the
// cursor: a fresh session does not replay the room's history, and misses nothing that arrives after it joined.
// The cursor moves past each message as it is handled, so a failed delivery loses none of the rest.
const watchCrewRoom = async ($: EngineInterface) => {
  const room = await read($, crewRoom)
  if (!room.topic || !room.me) return
  const key = `room-seq:${await $.session.id()}`
  const held = await $.store.get(key)
  const cursor = typeof held === 'number' ? held : undefined
  const asked = await askMesh($, 'mesh_read_inbox', cursor === undefined ? { room_topic: room.topic, limit: 1 } : { room_topic: room.topic, after_seq: cursor, limit: 200 })
  const page = (asked.result?.rooms as { room_topic: string; messages?: RoomMessage[]; next_after_seq?: number }[] | undefined)?.find(r => r.room_topic === room.topic)
  if (!page) return
  if (cursor === undefined) {
    if (typeof page.next_after_seq === 'number') await $.store.set(key, page.next_after_seq)
    return
  }
  let { waiting, dropped } = room
  for (const message of page.messages ?? []) {
    const accepted = acceptEnvelope(message, { me: room.me, roster: room.roster, supervisor: SUPERVISOR })
    if (accepted.deliver) {
      waiting = waitingOn(waiting, { type: 'received', inReplyTo: message.in_reply_to })
      await $.prompt.submit({ text: fenceDelivery(message, accepted, { boundary: boundary(), owner: OWNER, supervisor: SUPERVISOR }) })
    } else if (accepted.reason !== 'own') dropped += 1
    if (typeof message.seq === 'number') await $.store.set(key, message.seq)
  }
  if (typeof page.next_after_seq === 'number') await $.store.set(key, page.next_after_seq)
  const answered = Object.keys(waiting).length < Object.keys(room.waiting).length
  await update($, crewRoom, held => ({ ...held, waiting, dropped }))
  const beat = await read($, me)
  if (answered && beat?.state === 'waiting') return settle($, beat.lastLine)
  if (dropped !== room.dropped) await writeBeat($, {})
}

// A mesh_say this session sent that expects a reply: it waits on the recipients until one names it.
const noteSent = async ($: EngineInterface, ran: { result?: unknown }) => {
  const sent = (JSON.parse(textOf(((ran.result ?? {}) as { content?: { type: string; text?: string }[] }).content ?? [])) as { sent?: { message_id?: string; kind?: string; to?: string[] } }).sent
  if (!sent?.message_id || !sent.kind) return
  const room = await read($, crewRoom)
  const to = (sent.to ?? []).map(id => nameOf(room.roster, id) ?? id.slice(0, 8))
  await update($, crewRoom, held => ({ ...held, waiting: waitingOn(held.waiting, { type: 'sent', kind: sent.kind ?? '', messageId: sent.message_id ?? '', to }) }))
}

const goalOf = (result: Record<string, unknown>): CrewGoal | null => {
  const held = result.goal as Partial<CrewGoal> | undefined
  if (!held?.goal) return null
  return { goal: String(held.goal), packages: (held.packages ?? []).map(String), by: String(held.by ?? ''), at: Number(held.at) || 0 }
}

// A failed read keeps the goal last seen and says why, so a mesh hiccup never blanks the goal.
const loadGoal = async ($: EngineInterface) => {
  if (BOARD === 'off') return NO_GOAL
  const asked = await askBoard($, 'mcl-kanban/get_goal', {})
  return update($, goalView, seen => (asked.error !== undefined ? { goal: seen.goal, error: asked.error } : { goal: goalOf(asked.result ?? {}), error: '' }))
}

const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10)

const describeGoal = (view: CrewGoalView) => {
  const failed = view.error ? `The board could not be read: ${view.error}` : ''
  if (!view.goal) return [failed || 'No crew goal is set.', GOAL_USAGE].filter(Boolean).join('\n')
  const { goal, packages, by, at } = view.goal
  return [`Crew goal: ${goal}`, `Packages: ${packages.join(', ')}`, `Set ${dayOf(at)}${by ? ` by ${by}` : ''}.`, failed].filter(Boolean).join('\n')
}

const NOTHING_PENDING: CrewPending = { background: [], wakeups: 0 }
const pending = atom({ plugin: 'crew', key: 'pending' } as const, NOTHING_PENDING)
const REFRESH_LABEL = { none: '', due: 'refresh due after this turn', handover: 'handing over', clearing: 'clearing and resuming' } as const
const HANDOVER_WRITTEN = 'CREW-HANDOVER-WRITTEN'
const REFRESH_DECLINED = 'CREW-REFRESH-DECLINED'

// Opt-in is kept by the planet's name, not the session id: a /clear starts a new id.
// `refresh:<name>` holds a percent, or "auto": refresh after a task at AUTO_TASK_PERCENT,
// and when idle long enough that the prompt cache is about to lapse. The claim and handover
// limits apply to every session whatever this says; the board's claim is the card boundary.
const modeOf = async ($: EngineInterface, name: string) => await $.store.get(`refresh:${name}`)
const isAutoOf = async ($: EngineInterface, name: string) => (await modeOf($, name)) === 'auto'
const isPackageOf = async ($: EngineInterface, name: string) => (await modeOf($, name)) === 'package'
// A member told to stop is parked (`park:<name>`, by name as above): wake-on-idle never wakes it.
// The member parks itself with the crew_park tool; /crew-park is the owner's manual override.
const PARK_TOOL = 'mcp__crew__crew_park'
// A member told to refresh calls crew_refresh: the forced flow of /crew-refresh now, whatever its mode,
// which stays as it was. A handover a member writes on its own is invisible here and clears nothing.
const REFRESH_TOOL = 'mcp__crew__crew_refresh'
// Routine asks for the owner wait in a queue, one file per ask under the crew directory (so sessions
// never race on one file), until the Supervisor offers them together in one multi-select menu.
const QUEUE_TOOL = 'mcp__crew__queue_ask'
const TAKE_TOOL = 'mcp__crew__take_asks'
const asksDir = async ($: EngineInterface) => `${await crewDir($)}/asks`
const askFilesOf = async ($: EngineInterface) => {
  const dir = await asksDir($)
  const entries = await $.fs.list(dir).catch(() => [])

  return entries.map(entry => entry.name).filter(name => name.endsWith('.json')).sort().map(name => `${dir}/${name}`)
}
const queued = atom({ plugin: 'crew', key: 'asks' } as const, 0)
// Budget: the weekly window is the engine's own reading (seven_day); the Fable gauge has none, so the
// owner sets it with /crew-budget. The run-out is projected at the window's average pace so far.
const WEEK_MS = 7 * 24 * 3600_000
const weeklyOf = (rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]): CrewWeekly | null => {
  const window = rateLimits.find(limit => limit.kind === 'seven_day')
  const resetsAt = window?.resetsAt ? Date.parse(window.resetsAt) : NaN

  return window && Number.isFinite(resetsAt) ? { percent: window.percentUsed, resetsAt } : null
}
const runOutAt = ({ percent, resetsAt }: CrewWeekly, now: number) => {
  const startedAt = resetsAt - WEEK_MS
  return percent > 0 && now > startedAt ? startedAt + ((now - startedAt) * 100) / percent : null
}
const span = (ms: number) =>
  ms < 3600_000 ? `${Math.max(1, Math.round(ms / 60_000))}m` : ms < 24 * 3600_000 ? `${Math.round(ms / 3600_000)}h` : `${Math.round(ms / (24 * 3600_000))}d`
const fableOf = async ($: EngineInterface) => {
  const held = (await $.store.get('budget:fable').catch(() => undefined)) as { percent?: unknown; at?: unknown } | undefined
  return held && Number.isFinite(Number(held.percent)) ? { percent: Number(held.percent), at: Number(held.at) || 0 } : null
}
const budgetLine = (weekly: CrewWeekly | null, fable: { percent: number; at: number } | null, now: number) => {
  const runOut = weekly ? runOutAt(weekly, now) : null
  const parts = [
    ...(weekly ? [`weekly ${weekly.percent}% · resets in ${span(weekly.resetsAt - now)}`] : []),
    ...(weekly && runOut !== null && runOut < weekly.resetsAt ? [`runs out in ${span(Math.max(0, runOut - now))}, before the reset`] : []),
    ...(fable ? [`Fable ${fable.percent}% (set ${span(now - fable.at)} ago)`] : []),
  ]
  return parts.join(' · ')
}
const BUDGET_USAGE = 'Usage: /crew-budget shows the budget. /crew-budget fable <percent> sets the Fable gauge, /crew-budget fable off clears it.'
// A switch into needs-you alerts the owner once: the terminal bell in the session's own kitty tab (a BEL
// written to the claude process's terminal, which kitty rings and marks on the tab) and a desktop
// notification. `sound` (crew-wide, /crew-sound) mutes either or both.
// The shell the engine runs may sit under another one with no terminal, so it walks up the process tree
// to the first ancestor that has one: the claude process, on the member's kitty tab.
const BELL = 'p=$PPID; while [ "$p" -gt 1 ]; do t=$(ps -o tty= -p "$p" | tr -d " "); if [ -n "$t" ] && [ "$t" != "?" ]; then printf "\\a" > "/dev/$t"; exit 0; fi; p=$(ps -o ppid= -p "$p" | tr -d " "); done'
const SOUND_MODES = { on: 'bell and notification', bell: 'bell only', notify: 'notification only', off: 'muted' } as const
type SoundMode = keyof typeof SOUND_MODES
const soundOf = async ($: EngineInterface): Promise<SoundMode> => {
  const mode = await $.store.get('sound').catch(() => undefined)
  return typeof mode === 'string' && mode in SOUND_MODES ? (mode as SoundMode) : 'on'
}
const alertOwner = async ($: EngineInterface, beat: CrewBeat) => {
  const mode = await soundOf($)
  if (mode === 'on' || mode === 'bell') await $.process.run(['sh', '-c', BELL]).catch(() => null)
  if (mode === 'on' || mode === 'notify') {
    await $.process.run(['notify-send', '-a', 'crew', beat.name, beat.lastLine || `${beat.lastTool || 'something'} waits on you`]).catch(() => null)
  }
}
// The factory ledger (#16): append-only JSON lines, one file per session per ISO week, under the crew
// directory's ledger/<week>/, so sessions never write the same file. A plain log, not event sourcing.
// The mod logs what it sees (owner waits, menus, cards, refreshes); crew_log records the milestones only
// the crew knows. /crew-report sums a week.
const LOG_TOOL = 'mcp__crew__crew_log'
const SUPERVISOR_EVENTS = ['assigned', 'ask_sent', 'owner_yes', 'sent_back', 'live', 'closed']
const MEMBER_EVENTS = ['checkpoint', 'release', 'fix_after_ship', 'fable_round']
const LOG_EVENTS = [...SUPERVISOR_EVENTS, ...MEMBER_EVENTS]
const isoWeek = (at: number) => {
  const day = new Date(at)
  const date = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()))
  const weekday = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - weekday)
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1)
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7)

  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}
type LedgerEvent = { event: string; name: string; at: number; package?: string; note?: string; cost: number | null; weekly: number | null; ms?: number; from?: number }
const logEvent = async ($: EngineInterface, entry: { event: string; package?: string; note?: string; ms?: number; from?: number }) => {
  const at = await $.clock.now()
  const usage = await $.session.usage()
  const line: LedgerEvent = {
    ...entry,
    name: await currentName($),
    at,
    cost: usage.cost?.usd ?? null,
    weekly: weeklyOf(usage.rateLimits)?.percent ?? null,
  }
  const path = `${await crewDir($)}/ledger/${isoWeek(at)}/${await $.session.id()}.jsonl`
  const before = await $.fs.read(path).catch(() => '')
  await $.fs.write(path, `${before}${JSON.stringify(line)}\n`)
}
const packageOf = async ($: EngineInterface) => {
  const held = await $.store.get(`package:${await currentName($)}`).catch(() => undefined)
  return typeof held === 'string' && held ? held : undefined
}
// When this session's row went into needs-you, so the wait is logged when it comes out.
let needsSince: number | null = null

const costByName = (events: LedgerEvent[]) => {
  const byName = new Map<string, number[]>()
  events.forEach(event => {
    if (typeof event.cost === 'number') byName.set(event.name, [...(byName.get(event.name) ?? []), event.cost])
  })
  return new Map([...byName].map(([name, costs]) => [name, Math.max(...costs) - Math.min(...costs)]))
}
const sumOf = (values: Iterable<number>) => [...values].reduce((sum, value) => sum + value, 0)

const reportOf = (week: string, events: LedgerEvent[]) => {
  if (events.length === 0) return `No ledger for ${week} yet.`
  const packages = [...new Set(events.map(event => event.package).filter((ref): ref is string => Boolean(ref)))]
  const lines = packages.map(ref => {
    const of = events.filter(event => event.package === ref)
    const times = of.map(event => event.at)
    const wait = sumOf(of.filter(event => event.event === 'owner_wait').map(event => event.ms ?? 0))
    const rework = of.filter(event => event.event === 'sent_back' || event.event === 'fix_after_ship').length
    const releases = of.filter(event => event.event === 'release').length
    const cost = sumOf(costByName(of).values())
    return `- ${ref}: cycle ${span(Math.max(...times) - Math.min(...times))} · owner wait ${wait > 0 ? span(wait) : '0m'} · rework ${rework} · releases ${releases} · cost $${cost.toFixed(2)}`
  })
  const members = [...costByName(events)].sort((a, b) => b[1] - a[1]).map(([name, cost]) => `${name} $${cost.toFixed(2)}`)
  const gauges = events.map(event => event.weekly).filter((value): value is number => typeof value === 'number')
  const releases = events.filter(event => event.event === 'release').length
  const points = gauges.length > 0 ? Math.max(...gauges) - Math.min(...gauges) : 0
  const perRelease = releases > 0 ? ` · ${(points / releases).toFixed(1)} gauge points per release` : ''

  return [
    `Crew ledger ${week}: ${packages.length} ${packages.length === 1 ? 'package' : 'packages'}, ${releases} ${releases === 1 ? 'release' : 'releases'}, weekly gauge ${gauges.length ? `${Math.min(...gauges)}% → ${Math.max(...gauges)}%` : 'not read'}${perRelease}`,
    ...lines,
    `members: ${members.join(' · ') || 'no cost read'}`,
  ].join('\n')
}

const ledgerRulePrompt = (isSupervisor: boolean) =>
  `Crew ledger: log with crew_log (package, event, note) ` +
  (isSupervisor
    ? `each work package's milestones as they happen: ${SUPERVISOR_EVENTS.join(', ')}.`
    : `your own milestones on a package: ${MEMBER_EVENTS.join(', ')} (a release you shipped, a fix after shipping, a Fable round).`) +
  ' The crew mod logs owner waits, menus, cards and refreshes itself.'

// A review: a subagent whose type names review or an adversary, one asked to run on the reviewer model,
// or a review skill. A member may also declare one (report_progress phase), which holds across its tool
// calls until it says working or the turn ends.
// The reviewer model (the plugin's reviewer_model setting): a review subagent runs on it, whatever model the
// session asked for. A subagent counts as a review when its type or its description names one.
const REVIEWER_MODELS = ['fable', 'opus', 'sonnet', 'haiku']
let REVIEWER_MODEL = 'fable'
const isReviewText = (text: string) => /review|adversar/i.test(text)
const isReviewAgent = (e: { subagent_type?: unknown; description?: unknown }) =>
  isReviewText(String(e.subagent_type ?? '')) || isReviewText(String(e.description ?? ''))
const isReviewCall = (e: { tool: string; subagent_type?: unknown; description?: unknown; model?: unknown; skill?: unknown }) =>
  (e.tool === 'Agent' && (isReviewAgent(e) || String(e.model ?? '') === REVIEWER_MODEL)) ||
  (e.tool === 'Skill' && isReviewText(String(e.skill ?? '')))
// Model switching (#17): an assignment can name a model. The member calls crew_model when it starts the package;
// the mod switches the live session with /model (the engine runs a plugin's command as if the owner typed it, once
// the session is idle) and switches back to the member's configured model (member_models, else worker_model) when
// the member finishes or releases a card of that package, parks, or asks. Kept by name: a refresh keeps it.
const MODEL_TOOL = 'mcp__crew__crew_model'
let WORKER_MODEL = ''
let MEMBER_MODELS = new Map<string, string>()
type ModelSwitch = { model: string; package: string; reason: string; home: string }
const switchOf = async ($: EngineInterface, name: string) => {
  const held = (await $.store.get(`switched:${name}`).catch(() => undefined)) as ModelSwitch | undefined
  return held && typeof held.model === 'string' ? held : null
}
const modelWhyOf = async ($: EngineInterface, name: string) => {
  const held = await switchOf($, name)
  return held ? `for ${held.package} (${held.reason}), back to ${held.home} after` : ''
}
const homeModelOf = async ($: EngineInterface, name: string) =>
  MEMBER_MODELS.get(name.toLowerCase()) || WORKER_MODEL || (await $.session.model())
// Out of the turn's hook: a plugin's command cannot run inside a hook the turn waits on; the engine runs it once idle.
const runModel = ($: EngineInterface, model: string) =>
  $.clock.after(500, () => void $.command.run({ command: 'model', args: model }).catch(() => null))
const switchBack = async ($: EngineInterface, name: string) => {
  const held = await switchOf($, name)
  if (!held) return false
  await $.store.delete(`switched:${name}`)
  runModel($, held.home)
  await writeBeat($, {})
  return true
}
const modelPrompt = (isSupervisor: boolean) =>
  isSupervisor
    ? 'Crew models: when a package should run on another model (a torture run on a cheaper one), name it in the brief ' +
      '("on claude-sonnet-5-5"); the member switches with crew_model and back when the package ends. A switch happens only ' +
      'because an assignment asks for it, never because of usage limits.'
    : 'Crew models: when your assignment names a model, call crew_model with it, the package and why when you start the package. ' +
      'The crew mod switches this session after the turn, and back to your own model when you finish or release a card of that ' +
      'package, park, or call crew_model with model back. Never switch on your own.'

const reviewerPrompt = () =>
  `Crew reviews: reviews run on ${REVIEWER_MODEL}. When you spawn a subagent to review or attack work, the crew mod runs it on ${REVIEWER_MODEL}; ` +
  'name it as a review in its type or description so the dashboard shows it.'
let isReviewDeclared = false
// How long after a refresh its row shows the context it dropped from.
const REFRESHED_SHOWN_MS = 30 * 60_000
const isParkedOf = async ($: EngineInterface, name: string) => (await $.store.get(`park:${name}`)) === 1
const setParked = async ($: EngineInterface, name: string, isParked: boolean) => {
  await (isParked ? $.store.set(`park:${name}`, 1) : $.store.delete(`park:${name}`))
  await writeBeat($, {})
  await loadBeats($)
}
const thresholdOf = async ($: EngineInterface, name: string) => {
  const mode = await modeOf($, name)
  if (mode === 'auto') return AUTO_TASK_PERCENT
  return Number(mode) || 0
}
// Whether a refresh after a finished task runs: opted in, and the context at the threshold. Asked
// when the task finishes and again when the turn ends, so the dashboard never shows one that will not.
const isTaskRefreshDue = async ($: EngineInterface, name: string) => {
  const threshold = await thresholdOf($, name)
  return threshold > 0 && ((await $.session.usage()).context.percent ?? 0) >= threshold
}

const handoverPrompt = (path: string) => [
  `Crew refresh (${OWNER} opted this session in): your task is done and your context is large,`,
  'so this session will be cleared and restarted from a handover.',
  'First decide whether that is safe. If you hold an approved but unpushed range, sent a push or tag ask that has',
  'not been answered yet, are in the middle of a change,',
  `or are waiting on a reply you must act on, answer exactly ${REFRESH_DECLINED} and one line saying why.`,
  `Otherwise write your handover to ${path} (replace it if it exists), in the shape of your previous handovers:`,
  'first rules, what runs, open items in order, pending decisions, gotchas.',
  `Then answer exactly ${HANDOVER_WRITTEN}.`,
].join(' ')

// At the handover limit the session may be mid-card: it reaches a safe point first, it does
// not stop dead, and an approved push is made before anything else (the yes is for that sha).
const limitPrompt = (path: string, percent: number) => [
  `Crew handover: your context is at ${percent}%, past the ${HANDOVER_LIMIT}% handover limit, so this session hands over to a fresh one.`,
  'First reach a safe point: finish the edit you are in, then commit the work or stash it so the working tree is clean.',
  `If ${OWNER} approved a push you have not made yet, make that push first: that yes is for that exact sha.`,
  `Then write your handover to ${path} (replace it if it exists): the card id, branch and sha, what is done and what is left,`,
  'any failing test and what you know about it, and any open question or reply you are waiting on.',
  `Then answer exactly ${HANDOVER_WRITTEN}. Only if you cannot reach a safe point at all, answer exactly ${REFRESH_DECLINED} and one line saying why.`,
].join(' ')

// The resume names the member's assignment as it stands outside the chat, so a brief sent just before
// the refresh is never lost: the card it holds on the board and its newest brief file.
const resumePrompt = (name: string, path: string, card: string, brief: string) => [
  `You are ${name}. The crew mod just refreshed this session. Read your handover ${path}.`,
  ...(brief ? [`Read your brief ${brief}: it is your current assignment unless the handover says it is done.`] : []),
  ...(card ? [`You hold the board card ${card}; mcl-kanban/get_my_cards shows it.`] : []),
  'Read any messages that came in for you, then carry on with your assignment;',
  BOARD === 'off' ? `with none, tell the ${SUPERVISOR} you are free.` : 'with none, work the board.',
].join(' ')

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The member's newest brief, BRIEF_<date>_<name>.md next to its handovers, written by the Supervisor.
const briefOf = async ($: EngineInterface, name: string) => {
  const dir = `${(await $.env.get('HOME')) ?? ''}/.claude/sessions`
  const entries = await $.fs.list(dir).catch(() => [])
  const pattern = new RegExp(`^BRIEF_\\d{4}-\\d{2}-\\d{2}_${escaped(name)}\\.md$`)
  const newest = entries.map(entry => entry.name).filter(entry => pattern.test(entry)).sort().at(-1)

  return newest ? `${dir}/${newest}` : ''
}

const refreshRulePrompt = () =>
  `Crew refresh: when the ${SUPERVISOR} or ${OWNER} tells you to refresh, call crew_refresh with the reason and end your turn; ` +
  'the crew mod then asks you for your handover, clears this session and resumes it. Never write a handover on your own instead: ' +
  'the mod does not see it and nothing is cleared.'

const asksRulePrompt = () =>
  `Crew asks: one menu per change. Put everything one change needs from ${OWNER} (the code range, the tag, the fleet commit, ` +
  'in the order they run) in ONE yes/no ask. A routine ask that still needs an answer and is not part of a change ' +
  '(a cleanup, a branch or worktree to delete) goes to queue_ask, never into a menu of its own.'

const takeAsksPrompt = () =>
  `Crew ask queue: the dashboard shows how many routine asks wait. At a natural pause, when no other menu is open, call take_asks ` +
  `and offer what it returns to ${OWNER} as ONE AskUserQuestion with multiSelect, then act on, or relay, each answer.`

const briefRulePrompt = () =>
  'Crew briefs: when you assign work to a member, also write the brief to ~/.claude/sessions/BRIEF_<YYYY-MM-DD>_<Name>.md ' +
  "(the member's name, today's date). A refresh clears a member's chat; its resume prompt points at its newest brief, so the assignment survives."

const wakePrompt = () =>
  'The crew mod woke this session: it is idle with no card in hand. ' +
  'Read any messages that came in for you and act on them, then work the board. ' +
  `If an earlier instruction told you to stop, that stop stands over this wake-up: call crew_park with parked 1 and the reason, say so in one line, and end your turn.`

// The board loop, in every session's instructions, so the launcher, a resume and a wake-up
// only have to say "work the board". One copy; the launcher points at it.
// Answers that mean there is no board for this member, as opposed to a slow or failed call.
const isNoBoard = (error: string) => /no_provider|not_enlisted|not connected|no such server|unknown server|server .* not found/i.test(error)
const NO_BOARD_HINT = 'install the macula MCP server and get enlisted on the board, or set the crew plugin\'s board option to off'

// The board rules, or, when the board cannot be reached, why not: said once, so nobody keeps calling.
const boardSection = async ($: EngineInterface) => {
  if (BOARD === 'off') return null
  const { error } = await read($, goalView)
  if (isNoBoard(error)) return `Crew board: no board (${error}). Do not call mcl-kanban procedures; ${NO_BOARD_HINT}.`

  return boardPrompt()
}

const boardPrompt = () => [
  'Crew board: your work comes from the mcl-kanban board on the mesh, reached only through mesh_call.',
  ...(REALM ? [`The board is in realm ${REALM}: pass realm ${REALM} on every mcl-kanban mesh_call.`] : []),
  'Start with mcl-kanban/get_my_cards and finish a card you already hold before taking another.',
  'Otherwise take the next card with mcl-kanban/claim_next_card (no args): whatever it gives you is yours, in any repo.',
  'You own only the cards you hold; holding a work package card does not make the cards filed in it yours.',
  "Do the work the card's GitHub issue describes, then call mcl-kanban/finish_card with the card_id and a one-line result, and close the issue with that same line.",
  'Stuck on something real: mcl-kanban/block_card with the reason. Handing it back: mcl-kanban/release_card.',
  `When the board answers board_empty, tell the ${SUPERVISOR} you are free and stop.`,
  `The crew mod refuses a claim when your context is at ${CLAIM_LIMIT}% or more, and hands you over to a fresh session at ${HANDOVER_LIMIT}%.`,
  `Nothing is pushed or tagged without ${OWNER}'s yes for the exact sha range.`,
  'Name every container or process you start after yourself and stop only those, by exact name; never stop by image or filter.',
  `When the ${SUPERVISOR} or ${OWNER} tells you to stop or wind down, call crew_park with parked 1 and the reason; when told to resume, call it with parked 0.`,
].join(' ')

const contextPercent = async ($: EngineInterface) => (await $.session.usage()).context.percent ?? 0

const todayLocal = async ($: EngineInterface) =>
  (await $.process.run(['date', '+%F']).catch(() => null))?.stdout.trim() || new Date().toISOString().slice(0, 10)

// The planet's name now, even before this session's first beat.
const currentName = async ($: EngineInterface) =>
  (await read($, me))?.name || (await detectName($, await $.session.id()))

const startHandover = async ($: EngineInterface, name: string, isForced: boolean, isLimit = false) => {
  const home = (await $.env.get('HOME')) ?? ''
  const path = `${home}/.claude/sessions/HANDOVER_${await todayLocal($)}_${name}.md`
  const percent = await contextPercent($)
  await update($, refreshFlow, () => ({ phase: 'handover' as const, requestedAt: Date.now(), name, path, isForced, isLimit }))
  await writeBeat($, {})
  $.clock.after(500, () => void $.prompt.submit({ text: isLimit ? limitPrompt(path, percent) : handoverPrompt(path) }))
}

const abandonRefresh = async ($: EngineInterface, why: string) => {
  await update($, refreshFlow, () => IDLE_FLOW)
  await writeBeat($, {})
  $.ui.toast(`crew refresh skipped: ${why}`)
}

// Auto mode's second trigger: idle long enough that the prompt cache is about to lapse,
// so the next wake-up would resend the whole context at full price anyway.
const refreshWhenIdle = async ($: EngineInterface) => {
  const name = await currentName($)
  if (!(await isAutoOf($, name))) return
  if ((await read($, refreshFlow)).phase !== 'none') return
  const held = await read($, me)
  if (held?.state !== 'idle') return
  const lastActive = await read($, activeAt)
  if (lastActive === 0 || (await $.clock.now()) - lastActive < AUTO_IDLE_MS) return
  const percent = (await $.session.usage()).context.percent ?? 0
  if (percent < AUTO_IDLE_PERCENT) return
  await startHandover($, name, false)
}

// Wake-on-idle. A message does not wake an idle session, so a member that ended its turn waiting
// would never read it and never take the next card. Never the supervisor: the owner works in that one.
const wakeWhenIdle = async ($: EngineInterface) => {
  if (BOARD === 'off' || isNoBoard((await read($, goalView)).error)) return
  const name = await currentName($)
  if (name === SUPERVISOR || (await isParkedOf($, name))) return
  if ((await read($, refreshFlow)).phase !== 'none') return
  if ((await read($, me))?.state !== 'idle') return
  const lastActive = await read($, activeAt)
  if (lastActive === 0) return
  const now = await $.clock.now()
  const emptyAt = await read($, boardEmptyAt)
  if (emptyAt !== 0 && now - emptyAt < BOARD_EMPTY_MS) return
  const woken = await read($, wakes)
  const since = Math.max(lastActive, await read($, wokenAt))
  if (now - since < Math.min(WAKE_MAX_MS, WAKE_AFTER_MS * 2 ** woken)) return
  await update($, wakes, () => woken + 1)
  await update($, wokenAt, () => now)
  if ((await contextPercent($)) >= CLAIM_LIMIT) return startHandover($, name, true)
  await $.prompt.submit({ text: wakePrompt() })
}

// At the handover limit a finished turn starts the handover; it runs only on a turn that was not
// itself part of a refresh, so a declined handover is asked again on the next turn, not at once.
const handOverAtLimit = async ($: EngineInterface) => {
  if ((await read($, refreshFlow)).phase !== 'none') return
  if ((await contextPercent($)) < HANDOVER_LIMIT) return
  await startHandover($, await currentName($), true, true)
}

// Records the package of the card just claimed (by name, so the fresh session after a refresh knows
// it) and says whether package mode wants a handover before the card is started.
const crossesPackage = async ($: EngineInterface, workPackage: string, percent: number) => {
  const name = await currentName($)
  const last = await $.store.get(`package:${name}`)
  await $.store.set(`package:${name}`, workPackage)
  if (!(await isPackageOf($, name))) return false
  if (typeof last !== 'string' || last === '' || last === workPackage) return false
  if (percent < PACKAGE_MIN_PERCENT) return false
  if ((await read($, refreshFlow)).phase !== 'none') return false
  await update($, refreshFlow, flow => ({ ...flow, phase: 'due' as const, isForced: true }))
  await writeBeat($, {})

  return true
}

// The tool's answer with one more text block, so the model reads why it must not start.
const withNote = <T extends { result?: unknown }>(ran: T, note: string): T => {
  const answer = (ran.result ?? {}) as { content?: unknown[] }
  const content = Array.isArray(answer.content) ? answer.content : []
  return { ...ran, result: { ...answer, content: [...content, { type: 'text', text: note }] } }
}

const procedureOf = (call: { procedure?: unknown }) => String(call.procedure ?? '').replace(/^[0-9a-f]{64}\//i, '')
const claimedCardOf = (result: unknown) => {
  const text = JSON.stringify(result ?? '')
  const cardId = text.match(/(?<!to_)card_id\W+(card-[0-9a-f]{32})/)?.[1]
  const issueRef = text.match(/issue_ref\W+([\w.-]+\/[\w.-]+#\d+)/)?.[1] ?? ''
  const workPackage = text.match(/work_package\W+([\w.-]+\/[\w.-]+#\d+)/)?.[1] ?? ''

  return cardId ? { cardId, issueRef, workPackage } : null
}

// Context used per card, claim to finish: the data the two limits get tuned from.
const logCardUsage = async ($: EngineInterface, cardId: string, percent: number) => {
  const started = await read($, cardStart)
  if (!started || started.cardId !== cardId) return
  const path = `${await crewDir($)}/card-usage.tsv`
  const before = (await $.fs.exists(path)) ? await $.fs.read(path) : 'at\tname\tcard\tclaimed_at_percent\tfinished_at_percent\n'
  const at = new Date(await $.clock.now()).toISOString()
  await $.fs.write(path, `${before}${at}\t${await currentName($)}\t${cardId}\t${started.percent}\t${percent}\n`)
  await update($, cardStart, () => null)
  await writeBeat($, {})
}

// Runs after every main-loop turn: moves the refresh along, one step a turn.
const advanceRefresh = async ($: EngineInterface, answer: string) => {
  const flow = await read($, refreshFlow)
  if (flow.phase === 'due') {
    const name = await currentName($)
    if (!flow.isForced && !(await isTaskRefreshDue($, name))) return void (await update($, refreshFlow, () => IDLE_FLOW))
    if (lastLineOf(answer).endsWith('?')) return abandonRefresh($, 'the session ended its turn on a question')
    return startHandover($, name, flow.isForced)
  }
  if (flow.phase !== 'handover') return
  if (answer.includes(REFRESH_DECLINED)) return abandonRefresh($, `${flow.name} declined: ${lastLineOf(answer)}`)
  if (!answer.includes(HANDOVER_WRITTEN)) return abandonRefresh($, 'no handover confirmation')
  const written = await $.fs.stat(flow.path).catch(() => null)
  if (!written) return abandonRefresh($, `${flow.path} does not exist`)
  if (written.mtimeMs < flow.requestedAt) return abandonRefresh($, `handover not written to ${flow.path}`)
  await update($, refreshFlow, all => ({ ...all, phase: 'clearing' as const }))
  const fromPercent = await contextPercent($)
  await logEvent($, { event: 'refresh', package: await packageOf($), from: fromPercent })
  const card = await $.store.get(`card:${flow.name}`)
  const brief = await briefOf($, flow.name)
  // Out of the turn's hook: /clear cannot run inside a hook the turn waits on.
  $.clock.after(500, async () => {
    await $.command.run({ command: 'clear' })
    await $.store.set(`name:${await $.session.id()}`, flow.name)
    await $.store.set(`refreshed:${flow.name}`, await $.clock.now())
    await $.store.set(`refreshedFrom:${flow.name}`, fromPercent)
    await update($, tasks, () => ({}))
    await update($, reported, () => null)
    await update($, refreshFlow, () => IDLE_FLOW)
    await writeBeat($, { state: 'idle', lastLine: 'refreshed from handover', lastTool: '' })
    await $.prompt.submit({ text: resumePrompt(flow.name, flow.path, typeof card === 'string' ? card : '', brief) })
  })
}

const PROGRESS_TOOL = 'mcp__crew__report_progress'
const progressPrompt = () => [
  `Crew dashboard: ${OWNER} watches every session on a dashboard with a progress bar.`,
  `Call ${PROGRESS_TOOL} when you start an assigned task (step 0 with your best estimate of steps),`,
  'after each meaningful step, and once when it is done (step equal to of).',
  'Keep `task` short (under 60 characters) and name the outcome, not the process. It answers nothing; carry on after it.',
].join(' ')

// The task list as the session keeps it (TaskCreate/TaskUpdate), counted.
const fromTasks = (list: Record<string, CrewTask>, at: number): CrewProgress | null => {
  const all = Object.values(list)
  if (all.length === 0) return null
  const current = all.find(task => task.status === 'in_progress') ?? all.find(task => task.status === 'pending')
  const done = all.filter(task => task.status === 'completed').length

  return { task: current?.subject ?? all.at(-1)?.subject ?? '', step: done, of: all.length, source: 'tasks', at }
}

const crewDir = async ($: EngineInterface) => `${(await $.env.get('HOME')) ?? '/tmp'}/.claude/crew`

const firstMatch = (texts: string[], pattern: (planet: string) => RegExp) =>
  texts.flatMap(text => ROSTER.filter(member => pattern(member).test(text)))[0]

// The session's own name, as /rename (or `claude -n`) set it: the last
// custom-title entry in its transcript.
const sessionTitle = async ($: EngineInterface, sessionId: string) => {
  const home = (await $.env.get('HOME')) ?? ''
  const slug = (await $.session.root()).replace(/[^a-zA-Z0-9]/g, '-')
  const transcript = `${home}/.claude/projects/${slug}/${sessionId}.jsonl`
  const found = (await $.fs.exists(transcript))
    ? await $.process.run(['grep', '-o', '"customTitle":"[^"]*"', transcript]).catch(() => null)
    : null
  const last = found?.stdout.trim().split('\n').at(-1) ?? ''

  return last.match(/"customTitle":"([^"]*)"/)?.[1] || undefined
}

// A second session under a name the terminal already shows is titled "Mars (2)". The
// suffix is the terminal's, never part of a member's name, and keeping it mints a new
// member who never goes away: rows are one per name.
const rosterName = (title: string) => {
  const bare = title.replace(/\s*\(\d+\)$/, '').trim()
  return ROSTER.find(member => member.toLowerCase() === bare.toLowerCase()) ?? null
}

// /crew-name first, then the session's own title when it names a member, then CREW_NAME,
// the handover the session was pointed at, "you are X", the first planet named, and only
// last the title as given, for a session that is nobody on the roster.
const detectName = async ($: EngineInterface, sessionId: string) => {
  const stored = await $.store.get(`name:${sessionId}`)
  if (typeof stored === 'string' && stored) return stored
  const title = (await sessionTitle($, sessionId)) ?? ''
  const onRoster = rosterName(title)
  if (onRoster) return onRoster
  const fromEnv = await $.env.get('CREW_NAME')
  const texts = (await $.session.messages())
    .filter(message => message.role === 'user')
    .slice(0, 6)
    .map(message => message.text)
  const named =
    firstMatch(texts, planet => new RegExp(`HANDOVER_[^\\s]*${planet}`, 'i')) ??
    firstMatch(texts, planet => new RegExp(`\\byou(?:'re| are)\\s+${planet}\\b`, 'i')) ??
    firstMatch(texts, planet => new RegExp(`\\b${planet}\\b`, 'i'))

  return fromEnv || named || title || sessionId.slice(0, 8)
}

const lastLineOf = (answer: string) =>
  answer.split('\n').map(line => line.trim()).filter(Boolean).at(-1)?.slice(0, 160) ?? ''

// What the session still has in hand once a turn ended, for the "doing" column; '' when nothing.
const waitingOnOf = async ($: EngineInterface) => {
  const inFlight = await read($, pending)
  const progress = await read($, reported)
  const parts = [
    ...inFlight.background.map(task => task.label),
    ...(inFlight.wakeups > 0 ? [inFlight.wakeups === 1 ? 'a scheduled wake-up' : `${inFlight.wakeups} scheduled wake-ups`] : []),
    ...(progress && progress.step < progress.of ? [`${progress.task} (${progress.step}/${progress.of})`] : []),
    ...[...new Set(Object.values((await read($, crewRoom)).waiting))].map(who => `reply from ${who}`),
  ]

  return parts.join(', ')
}

// The state a finished turn leaves: a question for the owner, work in hand, or nothing.
const settle = async ($: EngineInterface, lastLine: string) => {
  if (lastLine.endsWith('?')) return writeBeat($, { state: 'needs-you', lastLine, waitingOn: '' })
  const waitingOn = await waitingOnOf($)
  const isReviewing = (await read($, pending)).background.some(task => isReviewText(task.label.split(':')[0] ?? ''))

  return writeBeat($, { state: isReviewing ? 'reviewing' : waitingOn ? 'waiting' : 'idle', lastLine, waitingOn })
}

const backgroundLabel = (task: { type: string; description: string; command?: string; agent_type?: string }) =>
  `${task.type === 'subagent' && task.agent_type ? task.agent_type : task.type}: ${(task.description || task.command || '').slice(0, 60)}`

// How an agent's loop ends (AgentStatus); a message may resume it, but it is no work in hand.
const AGENT_ENDED = ['completed', 'failed', 'killed']
const agentsOf = async ($: EngineInterface) => await $.agent.list().catch(() => null)

// The Stop hook's background work, each subagent the session's agent list names keeping its id.
const backgroundOf = async ($: EngineInterface, inFlight: { id: string; type: string; description: string; command?: string; agent_type?: string }[]) => {
  const agents = inFlight.some(task => task.type === 'subagent') ? await agentsOf($) : null
  const known = new Set((agents ?? []).map(agent => agent.id))

  return inFlight.map((task): CrewBackground => (task.type === 'subagent' && known.has(task.id) ? { label: backgroundLabel(task), agentId: task.id } : { label: backgroundLabel(task) }))
}

// The session's in-flight work as a Stop hook reports it; a row not mid-turn settles on it.
const takeInFlight = async ($: EngineInterface, e: { background_tasks?: Parameters<typeof backgroundOf>[1]; session_crons?: unknown[] }) => {
  const inFlight = { background: await backgroundOf($, e.background_tasks ?? []), wakeups: (e.session_crons ?? []).length }
  await update($, pending, () => inFlight)
  const held = await read($, me)
  if (held && held.state !== 'working' && held.state !== 'reviewing' && held.state !== 'needs-you') await settle($, held.lastLine)
}

// A background agent that ends while the session is idle brings no Stop, so the beat reads the
// session's agents again and one that ended (or that the engine dropped) leaves the "waiting on"
// list. A background shell has no such read: it stays listed until the next turn's Stop.
const dropEndedAgents = async ($: EngineInterface) => {
  const inFlight = await read($, pending)
  if (!inFlight.background.some(task => task.agentId)) return
  const agents = await agentsOf($)
  if (agents === null) return
  const live = new Set(agents.filter(agent => !AGENT_ENDED.includes(agent.status)).map(agent => agent.id))
  const background = inFlight.background.filter(task => task.agentId === undefined || live.has(task.agentId))
  if (background.length === inFlight.background.length) return
  await update($, pending, () => ({ ...inFlight, background }))
  const held = await read($, me)
  if (held?.state === 'waiting' || held?.state === 'reviewing') await settle($, held.lastLine)
}

const refreshOf = async ($: EngineInterface, name: string) => {
  const threshold = await thresholdOf($, name)
  const { phase } = await read($, refreshFlow)
  const isPackage = await isPackageOf($, name)
  const refreshedAt = Number(await $.store.get(`refreshed:${name}`)) || null
  const isRecent = refreshedAt !== null && (await $.clock.now()) - refreshedAt < REFRESHED_SHOWN_MS
  if (threshold === 0 && !isPackage && phase === 'none' && !isRecent) return null
  const from = Number(await $.store.get(`refreshedFrom:${name}`))
  const recent = isRecent && Number.isFinite(from) && from > 0 ? { fromPercent: from } : {}

  return { threshold, isAuto: await isAutoOf($, name), isPackage, refreshedAt, phase, ...recent }
}

// Sessions that ended in this process (a resume or a fork moved on). Timers started for
// one keep firing under its id; without this they write a ghost row that never goes offline.
const ended = new Set<string>()

const writeBeat = async ($: EngineInterface, change: Partial<CrewBeat>) => {
  const sessionId = await $.session.id()
  if (ended.has(sessionId)) return
  const held = await read($, me)
  const carried = held?.sessionId === sessionId ? held : null
  const usage = await $.session.usage()
  const repo = await $.session.repo()
  const name = change.name ?? (await detectName($, sessionId))
  const beat: CrewBeat = {
    sessionId,
    name,
    state: carried?.state ?? 'idle',
    lastTool: carried?.lastTool ?? '',
    lastLine: carried?.lastLine ?? '',
    waitingOn: carried?.waitingOn ?? '',
    progress: await read($, reported),
    refresh: await refreshOf($, change.name ?? name),
    card: (await read($, cardStart))?.issueRef ?? '',
    isParked: await isParkedOf($, change.name ?? name),
    ...change,
    repo: repo?.remote?.replace(/^.*[:/]([^/]+\/[^/]+?)(\.git)?$/, '$1') ?? (await $.session.cwd()),
    model: await $.session.model(),
    turns: await $.session.turns(),
    contextPercent: usage.context.percent ?? null,
    costUsd: usage.cost?.usd ?? null,
    fiveHourPercent: usage.rateLimits.find(limit => limit.kind === 'five_hour')?.percentUsed ?? null,
    weekly: weeklyOf(usage.rateLimits),
    modelWhy: await modelWhyOf($, change.name ?? name),
    roomDropped: (await read($, crewRoom)).dropped,
    startedAt: usage.startedAt,
    beatAt: await $.clock.now(),
  }
  await update($, me, () => beat)
  await $.fs.write(`${await crewDir($)}/${sessionId}.json`, JSON.stringify(beat))
  if (beat.state === 'needs-you' && carried?.state !== 'needs-you') {
    needsSince = beat.beatAt
    await alertOwner($, beat)
  }
  if (beat.state !== 'needs-you' && carried?.state === 'needs-you' && needsSince !== null) {
    const ms = beat.beatAt - needsSince
    needsSince = null
    await logEvent($, { event: 'owner_wait', package: await packageOf($), ms })
  }
}

// The beats directory also holds other crew files (roster.json, room.json): only a named, timed record is a beat.
// A beat from another host or an older mod can lack fields, so every one the pane reads gets a default.
const beatOf = (raw: unknown): CrewBeat | null => {
  const beat = raw as Partial<CrewBeat> | null
  if (!beat || typeof beat.name !== 'string' || beat.name === '' || typeof beat.beatAt !== 'number') return null
  return {
    ...beat,
    sessionId: beat.sessionId ?? '',
    name: beat.name,
    state: beat.state ?? 'idle',
    repo: beat.repo ?? '',
    model: beat.model ?? '',
    turns: beat.turns ?? 0,
    contextPercent: beat.contextPercent ?? null,
    costUsd: beat.costUsd ?? null,
    fiveHourPercent: beat.fiveHourPercent ?? null,
    lastTool: beat.lastTool ?? '',
    lastLine: beat.lastLine ?? '',
    progress: beat.progress ?? null,
    refresh: beat.refresh ?? null,
    startedAt: beat.startedAt ?? beat.beatAt,
    beatAt: beat.beatAt,
  }
}

const loadBeats = async ($: EngineInterface) => {
  const dir = await crewDir($)
  const entries = (await $.fs.exists(dir)) ? await $.fs.list(dir) : []
  const now = await $.clock.now()
  const parsed = await Promise.all(
    entries
      .filter(entry => entry.name.endsWith('.json'))
      .map(entry => {
        const path = `${dir}/${entry.name}`
        return $.fs.read(path).then(text => ({ path, beat: beatOf(JSON.parse(text)) })).catch(() => null)
      }),
  )
  const held = parsed.filter((entry): entry is { path: string; beat: CrewBeat } => entry !== null && entry.beat !== null)
  // Nothing else deletes these, so without this one file per session ever started piles up.
  const swept = held.filter(entry => now - entry.beat.beatAt > SWEEP_AFTER_MS).map(entry => entry.path)
  if (swept.length > 0) await $.process.run(['rm', '-f', ...swept]).catch(() => null)
  const live = held
    .filter(entry => !swept.includes(entry.path))
    .map(entry => entry.beat)
    .map(beat => ({ ...beat, state: stateOf(beat.state) }))
    .map(beat => (now - beat.beatAt > OFFLINE_AFTER_MS ? { ...beat, state: 'offline' as CrewState } : beat))
  // One row per name: the freshest session wins (a /clear or restart leaves the old file behind).
  const byName = new Map<string, CrewBeat>()
  live.forEach(beat => {
    const seen = byName.get(beat.name)
    if (!seen || seen.beatAt < beat.beatAt) byName.set(beat.name, beat)
  })
  const order = (beat: CrewBeat) => {
    const at = ROSTER.indexOf(beat.name)
    return at < 0 ? ROSTER.length : at
  }
  await update($, beats, () => [...byName.values()].sort((a, b) => order(a) - order(b)))
  const waiting = (await askFilesOf($)).length
  await update($, queued, () => waiting)
}

const ago = (now: number, at: number) => {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.round(seconds / 60)}m` : `${Math.round(seconds / 3600)}h`
}

const pad = (text: string, width: number) =>
  text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width)

const STATE_STYLE: Record<CrewState, { glyph: string; color?: string; isDim?: boolean }> = {
  working: { glyph: '●', color: 'green' },
  reviewing: { glyph: '◆', color: 'magenta' },
  'needs-you': { glyph: '!', color: 'yellow' },
  waiting: { glyph: '◐', color: 'blue' },
  idle: { glyph: '○', isDim: true },
  offline: { glyph: '·', color: 'gray' },
}

// A beat written by a session still on an older copy of this mod may name a state this one dropped.
const stateOf = (state: string): CrewState =>
  state === 'asking' ? 'needs-you' : state in STATE_STYLE ? (state as CrewState) : 'idle'

// A permission dialog that is open, with the row as it stood before it, so the call it
// stood on clears it once answered and a background subagent's puts the main loop's state back.
let openDialog: { before: Pick<CrewBeat, 'state' | 'lastLine' | 'lastTool'> | null } | null = null
// An MCP elicitation that is open, with the row as it stood before it.
let openElicitation: Pick<CrewBeat, 'state' | 'lastLine' | 'lastTool'> | null = null
const NOT_FOR_THE_OWNER = ['idle_prompt', 'auth_success', 'permission_prompt', 'elicitation_dialog']

export const register: Register = (on, options) => {
  const settings = options as { supervisor?: string; members?: string; owner?: string; board?: string; realm?: string; reviewer_model?: string; worker_model?: string; member_models?: string }
  WORKER_MODEL = settings.worker_model?.trim() ?? ''
  MEMBER_MODELS = new Map(
    namesOf(settings.member_models ?? '')
      .map(pair => pair.split(':').map(part => part.trim()))
      .filter(([name, model]) => name && model)
      .map(([name, model]) => [String(name).toLowerCase(), String(model)]),
  )
  REVIEWER_MODEL = REVIEWER_MODELS.includes(settings.reviewer_model?.trim() ?? '') ? (settings.reviewer_model ?? '').trim() : 'fable'
  BOARD = settings.board === 'off' ? 'off' : 'mesh'
  REALM = /^[0-9a-f]{64}$/i.test(settings.realm?.trim() ?? '') ? (settings.realm ?? '').trim().toLowerCase() : ''
  SUPERVISOR = settings.supervisor?.trim() || 'Supervisor'
  OWNER = settings.owner?.trim() || 'the owner'
  ROSTER = [SUPERVISOR, ...namesOf(settings.members ?? '').filter(name => name !== SUPERVISOR)]
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'crew', description: 'Open the crew dashboard: every member session at a glance' })
    await $.command.register({ name: 'crew-name', description: 'Name this session on the crew dashboard: /crew-name Ada' })
    await $.command.register({ name: 'crew-refresh', description: 'Refresh this session from a handover: after a task, at a package boundary, or now', argumentHint: 'auto|package [all]|on [percent]|off|now' })
    await $.command.register({ name: 'crew-goal', description: "Show the crew's goal, or set it: /crew-goal <package refs> <sentence>", argumentHint: '[org/repo#n [org/repo#m]] [sentence]' })
    await $.command.register({ name: 'crew-park', description: 'Park this session so wake-on-idle leaves it alone: /crew-park, and /crew-park off', argumentHint: 'off' })
    await $.command.register({ name: 'crew-report', description: "The crew ledger for a week: per package cost, cycle time, owner wait and rework", argumentHint: '[YYYY-Www]' })
    await $.command.register({ name: 'crew-sound', description: 'Bell and desktop notification when a session starts waiting on you: /crew-sound off mutes', argumentHint: 'on|off|bell|notify' })
    await $.command.register({ name: 'crew-budget', description: 'Show the budget gauges, or set the Fable one: /crew-budget fable 56', argumentHint: 'fable <percent>|fable off' })
    await $.command.register({ name: 'crew-progress', description: 'Turn progress reporting on or off for this session: /crew-progress off', argumentHint: 'on|off' })
    await $.tool.register({
      name: 'report_progress',
      description:
        `Report progress on your current assigned task to the crew dashboard ${OWNER} watches. ` +
        'Call it when you start a task (step 0), after each meaningful step, and once when done (step equal to of). ' +
        'Returns nothing useful; carry on with your work.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The task, short: under 60 characters, naming the outcome' },
          step: { type: 'integer', minimum: 0, description: 'Steps completed so far' },
          of: { type: 'integer', minimum: 1, description: 'Total steps, your best current estimate; revise it as you learn' },
          phase: { type: 'string', enum: ['reviewing', 'working'], description: 'reviewing while you review work (yours or another\'s), working when you are back at it' },
        },
        required: ['task', 'step', 'of'],
      },
    })
    await $.tool.register({
      name: 'crew_park',
      description:
        `Park or unpark this session on the crew dashboard ${OWNER} watches. A parked member is never woken on idle. ` +
        `Call it with parked 1 when the ${SUPERVISOR} or ${OWNER} tells you to stop or wind down, and with parked 0 when told to resume.`,
      inputSchema: {
        type: 'object',
        properties: {
          parked: { type: 'integer', enum: [0, 1], description: '1 parks this session, 0 unparks it' },
          reason: { type: 'string', description: 'Who told you to stop or resume, and why, in one line' },
        },
        required: ['parked', 'reason'],
      },
    })
    await $.tool.register({
      name: 'crew_refresh',
      description:
        `Refresh this session from a handover, now, whatever its refresh mode. Call it when the ${SUPERVISOR} or ${OWNER} tells you to refresh, ` +
        'then end your turn: the crew mod asks you for your handover, clears this session and resumes it. The refresh mode is left as it was.',
      inputSchema: {
        type: 'object',
        properties: { reason: { type: 'string', description: 'Who told you to refresh, and why, in one line' } },
        required: ['reason'],
      },
    })
    await $.tool.register({
      name: 'queue_ask',
      description:
        `Queue a routine yes/no ask for ${OWNER} instead of opening a menu for it: a cleanup, a branch or worktree to delete. ` +
        `The ${SUPERVISOR} offers queued asks together. Never queue part of a change: a change's asks go in one menu.`,
      inputSchema: {
        type: 'object',
        properties: { ask: { type: 'string', description: 'The question, answerable yes or no, naming exactly what would be done' } },
        required: ['ask'],
      },
    })
    await $.tool.register({
      name: 'crew_model',
      description:
        `Switch this session to the model your assignment names, when you start that package, or back with model "back". ` +
        'The crew mod switches after this turn, and back to your own model when you finish or release a card of that package or park.',
      inputSchema: {
        type: 'object',
        properties: {
          model: { type: 'string', description: 'The model the assignment names (a full id like claude-sonnet-5-5, or an alias), or "back"' },
          package: { type: 'string', description: 'The work package it is for, org/repo#n' },
          reason: { type: 'string', description: 'Why, in a few words, as the assignment says it' },
        },
        required: ['model', 'package', 'reason'],
      },
    })
    await $.tool.register({
      name: 'crew_log',
      description:
        `Log a work package milestone in the crew's ledger, which ${OWNER} reads to tune the crew for cost and speed. ` +
        `The ${SUPERVISOR} logs ${SUPERVISOR_EVENTS.join(', ')}; members log ${MEMBER_EVENTS.join(', ')}.`,
      inputSchema: {
        type: 'object',
        properties: {
          package: { type: 'string', description: 'The work package, org/repo#n' },
          event: { type: 'string', enum: LOG_EVENTS, description: 'What happened' },
          note: { type: 'string', description: 'One short line: the range, the release, why it was sent back' },
        },
        required: ['package', 'event'],
      },
    })
    await $.tool.register({
      name: 'take_asks',
      description: `Take every queued routine ask, oldest first, to offer them to ${OWNER} in one multi-select menu. The queue is emptied.`,
      inputSchema: { type: 'object', properties: {} },
    })
    await writeBeat($, { state: 'idle' })
    $.clock.every(BEAT_MS, () => void writeBeat($, {}))
    $.clock.every(BEAT_MS, () => void dropEndedAgents($))
    $.clock.every(REFRESH_MS, () => void loadBeats($))
    $.clock.every(IDLE_CHECK_MS, () => void refreshWhenIdle($))
    $.clock.every(IDLE_CHECK_MS, () => void wakeWhenIdle($))
    $.clock.every(GOAL_MS, () => void loadGoal($))
    $.clock.every(ROOM_POLL_MS, () => void watchCrewRoom($).catch(() => undefined))
    await loadBeats($)
    void loadGoal($)
    await joinCrewRoom($).catch(() => undefined)
    await watchCrewRoom($).catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: 'crew' }, async ($, e) => {
    if (e.args.trim() === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'Crew dashboard closed.' }
    }
    await loadBeats($)
    await loadGoal($)
    await $.ui.open({ id: PANE, title: 'Crew' })

    return { text: 'Crew dashboard opened. Close it with /crew close.' }
  })

  on('command.run', { command: 'crew-goal' }, async ($, e) => {
    if (BOARD === 'off') return { text: "The board is off (the crew plugin's board option), so there is no crew goal." }
    const words = e.args.trim().split(/\s+/).filter(Boolean)
    if (words.length === 0) return { text: describeGoal(await loadGoal($)) }
    const packages = words.slice(0, words.findIndex(word => !PACKAGE_REF.test(word)) >>> 0)
    const goal = words.slice(packages.length).join(' ')
    if (packages.length < 1 || packages.length > 2 || goal === '') return { text: GOAL_USAGE }
    const adopted = await askBoard($, 'mcl-kanban/adopt_goal', { goal, packages })
    if ('error' in adopted) return { text: `The board did not adopt the goal: ${adopted.error}` }

    return { text: describeGoal(await loadGoal($)) }
  })

  on('command.run', { command: 'crew-name' }, async ($, e) => {
    const name = e.args.trim()
    if (!name) return { text: `This session shows as ${(await read($, me))?.name ?? 'unnamed'}. Usage: /crew-name Venus` }
    await $.store.set(`name:${await $.session.id()}`, name)
    await writeBeat($, { name })
    await loadBeats($)

    return { text: `This session now shows as ${name} on the crew dashboard.` }
  })

  on('turn.start', async ($, e, next) => {
    // A turn runs here, so this session is live again (resumed back into this process).
    ended.delete(await $.session.id())
    const startedNow = await $.clock.now()
    await update($, activeAt, () => startedNow)
    await update($, pending, () => NOTHING_PENDING)
    isReviewDeclared = false
    await writeBeat($, { state: 'working', lastTool: '', waitingOn: '' })

    return next(e)
  })

  // A menu for the owner is waiting on them. A call that stood on a permission dialog puts
  // the row back once it resolves: working in a turn, as it was for a background subagent.
  // A background subagent's other calls leave the row alone: the main loop's state stands.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool).replace(/^mcp__/, '')
    const isSubagent = e.agentId !== undefined
    const isReview = !isSubagent && isReviewCall(e as unknown as { tool: string })
    // A review subagent runs on the reviewer model, whatever the session asked for.
    const call = isReview && e.tool === 'Agent' && isReviewAgent(e as unknown as { subagent_type?: unknown; description?: unknown })
      ? ({ ...e, model: REVIEWER_MODEL } as typeof e)
      : e
    if (isReview) await writeBeat($, { state: 'reviewing', lastTool: tool })
    else if (e.tool === 'AskUserQuestion') {
      await logEvent($, { event: 'menu', package: await packageOf($) })
      await writeBeat($, { state: 'needs-you', lastTool: tool, lastLine: 'answer the question menu' })
    }
    else if (!isSubagent) await writeBeat($, { state: isReviewDeclared ? 'reviewing' : 'working', lastTool: tool })
    const ran = await next(call)
    const dialog = openDialog
    if (isReview && dialog === null) {
      await writeBeat($, { state: isReviewDeclared ? 'reviewing' : 'working' })
      return ran
    }
    if (e.tool !== 'AskUserQuestion' && dialog === null) return ran
    openDialog = null
    await writeBeat($, isSubagent && dialog?.before ? dialog.before : { state: 'working' })

    return ran
  })

  // Fires before a permission dialog; a settings hook beneath may decide it, then no dialog shows.
  on('classic.PermissionRequest', async ($, e, next) => {
    const decided = await next(e)
    if (decided.decision !== undefined) return decided
    const held = await read($, me)
    openDialog = { before: held && held.state !== 'needs-you' ? { state: held.state, lastLine: held.lastLine, lastTool: held.lastTool } : null }
    const tool = e.tool_name.replace(/^mcp__/, '')
    await writeBeat($, { state: 'needs-you', lastTool: tool, lastLine: `permission for ${tool}` })

    return decided
  })

  // An MCP server asking the owner for input: a dialog in the tab until it is answered, unless a hook
  // beneath declined it (then no dialog shows).
  on('classic.Elicitation', async ($, e, next) => {
    const decided = await next(e)
    if (decided.block !== undefined) return decided
    const held = await read($, me)
    openElicitation = held && held.state !== 'needs-you' ? { state: held.state, lastLine: held.lastLine, lastTool: held.lastTool } : null
    await writeBeat($, { state: 'needs-you', lastTool: e.mcp_server_name, lastLine: `${e.mcp_server_name} asks: ${e.message}`.slice(0, 160) })

    return decided
  })

  on('classic.ElicitationResult', async ($, e, next) => {
    const done = await next(e)
    const before = openElicitation
    openElicitation = null
    await writeBeat($, before ?? { state: 'working' })

    return done
  })

  // The engine telling the owner something waits on them, in this tab. The idle prompt is the end of a
  // turn (the row already says idle or waiting); permission and elicitation dialogs have their own hooks.
  on('classic.Notification', async ($, e, next) => {
    const done = await next(e)
    if (!NOT_FOR_THE_OWNER.includes(e.notification_type)) {
      await writeBeat($, { state: 'needs-you', lastLine: (e.message || e.title || e.notification_type).slice(0, 160) })
    }

    return done
  })

  // The main loop's Stop knows what is still in flight; it may land before or after turn.complete.
  // A subagent's Stop carries the session's in-flight work too, so it refreshes the list between turns.
  on('classic.Stop', async ($, e, next) => {
    const done = await next(e)
    await takeInFlight($, e)

    return done
  })

  on('classic.SubagentStop', async ($, e, next) => {
    const done = await next(e)
    await takeInFlight($, e)

    return done
  })

  on('command.run', { command: 'crew-budget' }, async ($, e) => {
    const [gauge = '', value = ''] = e.args.trim().split(/\s+/)
    const now = await $.clock.now()
    if (gauge === 'fable' && value === 'off') await $.store.delete('budget:fable')
    else if (gauge === 'fable' && Number.isFinite(Number(value)) && value !== '') {
      await $.store.set('budget:fable', { percent: Math.min(100, Math.max(0, Number(value))), at: now })
    } else if (gauge !== '') return { text: BUDGET_USAGE }
    const weekly = (await read($, beats)).map(beat => beat.weekly).find(Boolean) ?? weeklyOf((await $.session.usage()).rateLimits)
    const line = budgetLine(weekly ?? null, await fableOf($), now)

    return { text: `${line ? `Budget: ${line}.` : 'No budget reading yet.'} ${BUDGET_USAGE}` }
  })

  on('command.run', { command: 'crew-sound' }, async ($, e) => {
    const wanted = e.args.trim()
    if (wanted in SOUND_MODES) await $.store.set('sound', wanted)
    else if (wanted !== '') return { text: 'Usage: /crew-sound on | off | bell | notify' }

    return { text: `Crew alerts when a session starts waiting on ${OWNER}: ${SOUND_MODES[await soundOf($)]}, for the whole crew. Usage: /crew-sound on | off | bell | notify` }
  })

  on('command.run', { command: 'crew-park' }, async ($, e) => {
    const name = await currentName($)
    const wanted = e.args.trim()
    if (wanted !== '' && wanted !== 'off') {
      return { text: `${name} is ${(await isParkedOf($, name)) ? 'parked' : 'not parked'}. Usage: /crew-park parks this session, /crew-park off unparks it.` }
    }
    await setParked($, name, wanted !== 'off')

    return {
      text: wanted === 'off'
        ? `${name} is unparked: wake-on-idle wakes it again to work the board.`
        : `${name} is parked: wake-on-idle no longer wakes it, and the dashboard shows it parked. /crew-park off unparks it.`,
    }
  })

  on('command.run', { command: 'crew-progress' }, async ($, e) => {
    const key = `progress-off:${await $.session.id()}`
    const wanted = e.args.trim()
    if (wanted !== 'on' && wanted !== 'off') {
      const isOff = (await $.store.get(key)) === 1
      return { text: `Progress reporting is ${isOff ? 'off' : 'on'} for this session. Usage: /crew-progress on|off` }
    }
    await (wanted === 'off' ? $.store.set(key, 1) : $.store.delete(key))
    if (wanted === 'off') await update($, reported, () => null)
    await writeBeat($, {})

    return { text: `Progress reporting ${wanted} for this session; it takes effect from the next turn.` }
  })

  on('command.run', { command: 'crew-refresh' }, async ($, e) => {
    const name = await currentName($)
    const [wanted = '', level = ''] = e.args.trim().split(/\s+/)
    const threshold = await thresholdOf($, name)
    if (wanted === 'off') {
      await $.store.delete(`refresh:${name}`)
      await update($, refreshFlow, () => IDLE_FLOW)
      await writeBeat($, {})
      return { text: `Auto-refresh off for ${name}.` }
    }
    if (wanted === 'auto') {
      await $.store.set(`refresh:${name}`, 'auto')
      await writeBeat($, {})
      return {
        text:
          `Auto-refresh on for ${name}, auto mode: after a finished task at ${AUTO_TASK_PERCENT}% context or more, ` +
          `and after ${AUTO_IDLE_MS / 60_000} idle minutes at ${AUTO_IDLE_PERCENT}% or more, before the prompt cache lapses.`,
      }
    }
    if (wanted === 'on') {
      const chosen = Math.min(95, Math.max(5, Number(level) || DEFAULT_THRESHOLD))
      await $.store.set(`refresh:${name}`, chosen)
      await writeBeat($, {})
      return { text: `Auto-refresh on for ${name}: after a finished task, when context is at ${chosen}% or more, it writes its handover and restarts from it.` }
    }
    if (wanted === 'package') {
      const seen = (await read($, beats)).map(beat => beat.name)
      const members = level === 'all' ? [...new Set([...ROSTER, ...seen])].filter(member => member !== SUPERVISOR) : [name]
      await Promise.all(members.map(member => $.store.set(`refresh:${member}`, 'package')))
      await writeBeat($, {})
      return {
        text:
          `Package mode on for ${members.join(', ')}: keeps context across the cards of one work package, and hands over ` +
          `when the board gives a card from another package, unless context is under ${PACKAGE_MIN_PERCENT}%.`,
      }
    }
    if (wanted === 'now') {
      await startHandover($, name, true)
      return { text: `Refreshing ${name} now: it checks it is safe, writes its handover, then clears and resumes.` }
    }
    const last = Number(await $.store.get(`refreshed:${name}`)) || 0
    return {
      text:
        `Auto-refresh is ${(await isAutoOf($, name)) ? 'on, auto mode' : (await isPackageOf($, name)) ? 'on, package mode' : threshold ? `on at ${threshold}%` : 'off'} for ${name}` +
        `${last ? `; last refreshed ${new Date(last).toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''}. ` +
        `Usage: /crew-refresh auto | package [all] | on [percent] | off | now. Every session also hands over at ${HANDOVER_LIMIT}% and takes no new card at ${CLAIM_LIMIT}%.`,
    }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const boardText = await boardSection($)
    const board = boardText === null ? [] : [{ id: 'crew:board', text: boardText, scope: 'session' as const }]
    const isOff = (await $.store.get(`progress-off:${await $.session.id()}`)) === 1
    const progress = isOff ? [] : [{ id: 'crew:progress', text: progressPrompt(), scope: 'session' as const }]
    const refresh = [{ id: 'crew:refresh', text: refreshRulePrompt(), scope: 'session' as const }]
    const isSupervisor = (await currentName($)) === SUPERVISOR
    const briefs = isSupervisor ? [{ id: 'crew:briefs', text: briefRulePrompt(), scope: 'session' as const }] : []
    const line = isSupervisor ? budgetLine(weeklyOf((await $.session.usage()).rateLimits), await fableOf($), await $.clock.now()) : ''
    const budget = line
      ? [{
          id: 'crew:budget',
          text: `Crew budget: ${line}. This is a measurement for ${OWNER}; change the crew's pace only when ${OWNER} says so.`,
          scope: 'session' as const,
        }]
      : []
    const asks = [
      { id: 'crew:asks', text: asksRulePrompt(), scope: 'session' as const },
      ...(isSupervisor ? [{ id: 'crew:ask-queue', text: takeAsksPrompt(), scope: 'session' as const }] : []),
    ]

    const ledger = [
      { id: 'crew:ledger', text: ledgerRulePrompt(isSupervisor), scope: 'session' as const },
      { id: 'crew:reviews', text: reviewerPrompt(), scope: 'session' as const },
      { id: 'crew:models', text: modelPrompt(isSupervisor), scope: 'session' as const },
    ]

    const room = await read($, crewRoom)
    const roomText = room.topic
      ? roomRulesPrompt({ topic: room.topic, roster: room.roster, supervisor: SUPERVISOR, owner: OWNER })
      : `Crew room: none for this session (no room.json from the ${SUPERVISOR}, or this member is not in roster.json, which bin/crew writes).`
    const crewRoomSection = [{ id: 'crew:room', text: roomText, scope: 'session' as const }]

    return { ...composed, sections: [...composed.sections, ...board, ...progress, ...refresh, ...briefs, ...asks, ...budget, ...ledger, ...crewRoomSection] }
  })

  // The board is the card boundary: a claim at or above the claim limit is refused and turns
  // into a handover, a claimed card resets the wake backoff, and a finished card is logged.
  // A question or a handed-over task in the crew room: this session waits on the reply (#18).
  on('tool.call', { tool: MESH_SAY }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) await noteSent($, ran).catch(() => undefined)

    return ran
  })

  on('tool.call', { tool: MESH_CALL }, async ($, e, next) => {
    const call = e as unknown as { procedure?: unknown; args?: { card_id?: unknown } }
    const procedure = procedureOf(call)
    const isClaim = CLAIMS.includes(procedure)
    const percent = await contextPercent($)
    if (isClaim && percent >= CLAIM_LIMIT) {
      await update($, refreshFlow, flow => (flow.phase === 'none' ? { ...flow, phase: 'due' as const, isForced: true } : flow))
      return {
        deny:
          `Your context is at ${percent}%, at or over the ${CLAIM_LIMIT}% limit for starting a card, so the crew mod refused this claim. ` +
          'Do not take new work: this session hands over at the end of this turn, and a fresh session takes the next card.',
      }
    }
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const now = await $.clock.now()
    if (isClaim && JSON.stringify(ran.result ?? '').includes('board_empty')) await update($, boardEmptyAt, () => now)
    const claimed = isClaim ? claimedCardOf(ran.result) : null
    if (claimed) {
      await update($, wakes, () => 0)
      await update($, boardEmptyAt, () => 0)
      await update($, cardStart, () => ({ cardId: claimed.cardId, issueRef: claimed.issueRef, percent }))
      // By name, so the fresh session after a refresh is pointed at the card it holds.
      if (claimed.issueRef) await $.store.set(`card:${await currentName($)}`, claimed.issueRef)
      await writeBeat($, {})
      const crosses = await crossesPackage($, claimed.workPackage, percent)
      await logEvent($, { event: 'card_claimed', package: claimed.workPackage || undefined, note: claimed.issueRef })
      if (crosses) return withNote(ran, PACKAGE_HANDOVER_NOTE)
    }
    if (procedure === 'mcl-kanban/finish_card' || procedure === 'mcl-kanban/release_card') {
      const name = await currentName($)
      await $.store.delete(`card:${name}`)
      const held = await switchOf($, name)
      if (held && held.package === (await packageOf($))) await switchBack($, name)
    }
    if (procedure === 'mcl-kanban/finish_card') {
      await logEvent($, { event: 'card_finished', package: await packageOf($), note: (await read($, cardStart))?.issueRef ?? '' })
      await logCardUsage($, String(call.args?.card_id ?? ''), percent)
    }

    return ran
  })

  on('tool.call', { tool: PROGRESS_TOOL }, async ($, e) => {
    if ((await $.store.get(`progress-off:${await $.session.id()}`)) === 1) {
      return { result: 'Progress reporting is off for this session; no need to call this.' }
    }
    const input = e as unknown as { task?: unknown; step?: unknown; of?: unknown }
    const of = Math.max(1, Math.floor(Number(input.of) || 1))
    const step = Math.min(of, Math.max(0, Math.floor(Number(input.step) || 0)))
    const task = String(input.task ?? '').slice(0, 80)
    const phase = (e as unknown as { phase?: unknown }).phase
    if (phase === 'reviewing' || phase === 'working') isReviewDeclared = phase === 'reviewing'
    await update($, reported, () => ({ task, step, of, source: 'report' as const, at: Date.now() }))
    if (step >= of && (await isTaskRefreshDue($, await currentName($)))) {
      await update($, refreshFlow, flow => (flow.phase === 'none' ? { ...flow, phase: 'due' as const } : flow))
    }
    await writeBeat($, phase === 'reviewing' || phase === 'working' ? { state: phase } : {})

    return { result: `Progress noted: ${step}/${of} ${task}` }
  })

  on('tool.call', { tool: PARK_TOOL }, async ($, e) => {
    const input = e as unknown as { parked?: unknown; reason?: unknown }
    const name = await currentName($)
    const isParked = Number(input.parked) === 1
    const reason = String(input.reason ?? '').slice(0, 160)
    await setParked($, name, isParked)
    if (isParked) await switchBack($, name)

    return { result: isParked ? `${name} is parked (${reason}): wake-on-idle no longer wakes it. End your turn.` : `${name} is unparked (${reason}): wake-on-idle wakes it again to work the board.` }
  })

  on('tool.call', { tool: MODEL_TOOL }, async ($, e) => {
    const input = e as unknown as { model?: unknown; package?: unknown; reason?: unknown }
    const model = String(input.model ?? '').trim()
    const ref = String(input.package ?? '').trim()
    const name = await currentName($)
    if (model === 'back') {
      const held = await switchOf($, name)
      return { result: (await switchBack($, name)) ? `Switching back to ${held?.home} after this turn.` : 'This session already runs on its own model.' }
    }
    if (!/^[a-z0-9][a-z0-9.-]*$/i.test(model)) return { result: 'Not switched: model must be a model id or alias, like claude-sonnet-5-5.' }
    if (!PACKAGE_REF.test(ref)) return { result: 'Not switched: package must be a work package ref, org/repo#n.' }
    const home = (await switchOf($, name))?.home ?? (await homeModelOf($, name))
    await $.store.set(`switched:${name}`, { model, package: ref, reason: String(input.reason ?? '').slice(0, 80), home })
    runModel($, model)
    await writeBeat($, {})

    return { result: `Switching to ${model} for ${ref} after this turn; back to ${home} when the package's card is finished or released, or you park.` }
  })

  on('tool.call', { tool: LOG_TOOL }, async ($, e) => {
    const input = e as unknown as { package?: unknown; event?: unknown; note?: unknown }
    const event = String(input.event ?? '')
    const ref = String(input.package ?? '').trim()
    if (!LOG_EVENTS.includes(event)) return { result: `Not logged: event must be one of ${LOG_EVENTS.join(', ')}.` }
    if (!PACKAGE_REF.test(ref)) return { result: 'Not logged: package must be a work package ref, org/repo#n.' }
    await logEvent($, { event, package: ref, note: String(input.note ?? '').slice(0, 200) })

    return { result: `${event} logged for ${ref}.` }
  })

  on('command.run', { command: 'crew-report' }, async ($, e) => {
    const week = e.args.trim() || isoWeek(await $.clock.now())
    if (!/^\d{4}-W\d{2}$/.test(week)) return { text: 'Usage: /crew-report [YYYY-Www], the ISO week (default this one).' }
    const dir = `${await crewDir($)}/ledger/${week}`
    const files = (await $.fs.list(dir).catch(() => [])).filter(entry => entry.name.endsWith('.jsonl'))
    const texts = await Promise.all(files.map(entry => $.fs.read(`${dir}/${entry.name}`).catch(() => '')))
    const events = texts
      .flatMap(text => text.split('\n'))
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line) as LedgerEvent } catch { return null } })
      .filter((event): event is LedgerEvent => event !== null)
      .sort((a, b) => a.at - b.at)

    return { text: reportOf(week, events) }
  })

  on('tool.call', { tool: QUEUE_TOOL }, async ($, e) => {
    const ask = String((e as unknown as { ask?: unknown }).ask ?? '').trim().slice(0, 300)
    if (ask === '') return { result: 'Nothing queued: the ask is empty.' }
    const at = await $.clock.now()
    const id = `${String(at).padStart(15, '0')}-${(await $.session.id()).slice(0, 8)}-${Math.random().toString(36).slice(2, 8)}`
    await $.fs.write(`${await asksDir($)}/${id}.json`, JSON.stringify({ from: await currentName($), ask, at }))
    const waiting = (await askFilesOf($)).length
    await update($, queued, () => waiting)

    return { result: `Queued for ${OWNER}; ${waiting} ${waiting === 1 ? 'ask' : 'asks'} waiting. Do not open a menu for it; carry on.` }
  })

  on('tool.call', { tool: TAKE_TOOL }, async ($) => {
    const paths = await askFilesOf($)
    const asks = (await Promise.all(paths.map(path => $.fs.read(path).then(text => JSON.parse(text) as { from: string; ask: string; at: number }).catch(() => null))))
      .filter((ask): ask is { from: string; ask: string; at: number } => ask !== null)
      .sort((a, b) => a.at - b.at)
    if (paths.length > 0) await $.process.run(['rm', '-f', ...paths]).catch(() => null)
    await update($, queued, () => 0)
    if (asks.length === 0) return { result: 'No asks are queued.' }

    return {
      result: [
        `${asks.length} queued ${asks.length === 1 ? 'ask' : 'asks'}, oldest first. Offer them to ${OWNER} as ONE AskUserQuestion with multiSelect (at most 4 options a question; split into questions of the same menu when there are more), then act on or relay each answer:`,
        ...asks.map(ask => `- ${ask.from}: ${ask.ask}`),
      ].join('\n'),
    }
  })

  on('tool.call', { tool: REFRESH_TOOL }, async ($, e) => {
    const reason = String((e as unknown as { reason?: unknown }).reason ?? '').slice(0, 160)
    const flow = await read($, refreshFlow)
    if (flow.phase !== 'none') return { result: `A refresh is already under way (${REFRESH_LABEL[flow.phase]}); nothing more to do. End your turn.` }
    await update($, refreshFlow, all => ({ ...all, phase: 'due' as const, isForced: true, isLimit: false }))
    await writeBeat($, {})

    return {
      result:
        `Refresh requested (${reason}). End your turn now: the crew mod then asks you for your handover, clears this session ` +
        'and resumes it from the handover. Your refresh mode is unchanged.',
    }
  })

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    const id = ran.deny === undefined && ran.isError !== true ? ran.result?.task?.id : undefined
    if (id === undefined) return ran
    const list = await update($, tasks, all => ({ ...all, [id]: { subject: e.subject, status: 'pending' as const } }))
    await update($, reported, () => fromTasks(list, Date.now()))
    await writeBeat($, {})

    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const list = await update($, tasks, all => {
      const known = all[e.taskId]
      if (e.status === 'deleted') {
        const { [e.taskId]: _gone, ...rest } = all
        return rest
      }
      const subject = e.subject ?? known?.subject ?? e.taskId
      const status = e.status ?? known?.status ?? 'pending'
      return { ...all, [e.taskId]: { subject, status } }
    })
    await update($, reported, () => fromTasks(list, Date.now()))
    await writeBeat($, {})

    return ran
  })

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const list = Object.fromEntries(e.todos.map((todo, at) => [String(at), { subject: todo.activeForm || todo.content, status: todo.status }]))
    await update($, tasks, () => list)
    await update($, reported, () => fromTasks(list, Date.now()))
    await writeBeat($, {})

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    const lastLine = lastLineOf(e.answer)
    isReviewDeclared = false
    const endedNow = await $.clock.now()
    await update($, activeAt, () => endedNow)
    await settle($, lastLine)
    const phaseBefore = (await read($, refreshFlow)).phase
    await advanceRefresh($, e.answer)
    if (phaseBefore === 'none') await handOverAtLimit($)

    return done
  })

  on('session.end', async ($, e, next) => {
    await writeBeat($, { state: 'offline' })
    ended.add(e.sessionId)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, beats)
    const now = await $.clock.now()
    const width = Math.max(40, e.props.bodyColumns)
    const online = list.filter(beat => beat.state !== 'offline')
    const total = list.reduce((sum, beat) => sum + (beat.costUsd ?? 0), 0)
    const fiveHour = Math.max(...list.map(beat => beat.fiveHourPercent ?? 0))
    const lineWidth = Math.max(10, width - 2)
    const { goal, error } = await read($, goalView)
    const needy = list.filter(beat => beat.state === 'needs-you')
    const waitingAsks = await read($, queued)
    const freshest = [...online].sort((a, b) => b.beatAt - a.beatAt).map(beat => beat.weekly).find(Boolean) ?? null
    const budget = budgetLine(freshest, await fableOf($), now)

    return (
      <Box flexDirection="column">
        {needy.length > 0 && (
          <Box flexDirection="column">
            <Text color="yellow" bold>needs you ({needy.length})</Text>
            {needy.map(beat => (
              <Text color="yellow" wrap="truncate-end">{`  ! ${beat.name} tab: ${beat.lastLine || `${beat.lastTool || 'something'} waits on you`}`}</Text>
            ))}
          </Box>
        )}
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>
            {`${online.length}/${list.length} online · $${total.toFixed(2)} spent · 5h window ${fiveHour.toFixed(0)}%`}{waitingAsks > 0 ? <Text color="yellow">{` · ${waitingAsks} ${waitingAsks === 1 ? 'ask' : 'asks'} waiting`}</Text> : null}
          </Text>
          <Button key="close" label="close" hotkey="x" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
        </Box>
        {budget !== '' && <Text color={/before the reset/.test(budget) ? 'red' : undefined} wrap="truncate-end">{`budget: ${budget}`}</Text>}
        {BOARD === 'mesh' && (goal ? (
          <Text wrap="truncate-end">
            <Text color="cyan" bold>goal </Text>
            {goal.goal} <Text dimColor>· {goal.packages.join(', ')} · set {dayOf(goal.at)}{goal.by ? ` by ${goal.by}` : ''}</Text>
          </Text>
        ) : (
          <Text dimColor wrap="truncate-end">No crew goal set. /crew-goal &lt;package refs&gt; &lt;sentence&gt; sets one.</Text>
        ))}
        {error !== '' && (
          <Text color="yellow" wrap="truncate-end">{isNoBoard(error) ? `no board: ${error} (${NO_BOARD_HINT})` : `board unreachable: ${error}`}</Text>
        )}
        <Text dimColor>{pad('', 2)}{pad('name', 11)}{pad('state', 10)}{pad('ctx', 5)}{pad('cost', 8)}{pad('turns', 6)}{pad('seen', 5)}repo · doing</Text>
        {list.length === 0 && <Text dimColor>No planet has checked in yet. Sessions appear as they start with the crew mod loaded.</Text>}
        {list.map(beat => {
          const style = STATE_STYLE[beat.state]
          const isOff = beat.state === 'offline'
          const activity =
            beat.state === 'reviewing' ? `reviewing${beat.waitingOn ? `: ${beat.waitingOn}` : beat.lastTool ? ` with ${beat.lastTool}` : ''}`
            : beat.state === 'working' && beat.lastTool ? `running ${beat.lastTool}`
            : beat.state === 'waiting' ? `waiting on ${beat.waitingOn || 'nothing it named'}`
            : beat.lastLine
          const doing = beat.card ? `${beat.card} · ${activity}` : activity

          return (
            <Box flexDirection="column">
              <Text dimColor={isOff}>
                <Text color={style.color} dimColor={style.isDim}>{style.glyph} </Text>
                <Text bold={!isOff}>{pad(beat.name, 11)}</Text>
                <Text color={style.color} dimColor={style.isDim}>{pad(beat.state, 10)}</Text>
                <Text color={(beat.contextPercent ?? 0) >= 80 ? 'red' : undefined}>{pad(beat.contextPercent === null ? '-' : `${beat.contextPercent}%`, 5)}</Text>
                {pad(beat.costUsd === null ? '-' : `$${beat.costUsd.toFixed(2)}`, 8)}
                {pad(String(beat.turns), 6)}
                {pad(ago(now, beat.beatAt), 5)}
                {beat.refresh && (beat.refresh.isAuto || beat.refresh.isPackage || beat.refresh.threshold > 0) && (
                  <Text color="magenta">↻{beat.refresh.isAuto ? 'auto' : beat.refresh.isPackage ? 'pkg' : `${beat.refresh.threshold}%`} </Text>
                )}
                {beat.isParked && <Text color="yellow">parked </Text>}
                {beat.repo}
                {beat.model ? <Text dimColor>{` · ${beat.model.replace(/^claude-/, '')}`}</Text> : null}
                {beat.modelWhy ? <Text color="cyan">{` ${beat.modelWhy}`}</Text> : null}
                {beat.roomDropped ? <Text color="yellow">{` · room: ${beat.roomDropped} dropped`}</Text> : null}
              </Text>
              {beat.progress && !isOff && (() => {
                const { task, step, of } = beat.progress
                const isDone = step >= of
                const filled = Math.round((BAR_CELLS * step) / of)

                return (
                  <Text wrap="truncate-end">
                    {'  '}
                    <Text color={isDone ? 'cyan' : 'green'}>{'█'.repeat(filled)}</Text>
                    <Text dimColor>{'░'.repeat(BAR_CELLS - filled)}</Text>
                    {` ${isDone ? 'done' : `${step}/${of}`} `}
                    <Text dimColor={isDone}>{pad(task, Math.max(10, lineWidth - BAR_CELLS - 10))}</Text>
                  </Text>
                )
              })()}
              {beat.refresh && beat.refresh.phase !== 'none' && !isOff && (
                <Text color="magenta">{'  '}↻ {REFRESH_LABEL[beat.refresh.phase]}</Text>
              )}
              {beat.refresh?.fromPercent !== undefined && beat.refresh.phase === 'none' && beat.refresh.refreshedAt !== null && now - beat.refresh.refreshedAt < REFRESHED_SHOWN_MS && !isOff && (
                <Text color="magenta">{`  ↻ refreshed ${beat.refresh.fromPercent}% → ${beat.contextPercent ?? '-'}% ${ago(now, beat.refresh.refreshedAt)} ago`}</Text>
              )}
              {doing !== '' && !isOff && <Text dimColor wrap="truncate-end">{'  '}{pad(doing, lineWidth)}</Text>}
            </Box>
          )
        })}
      </Box>
    )
  })
}
