// crew for OpenCode (v2 plugin API, OpenCode 2.x): puts an OpenCode member on the same crew
// dashboard as the Claude Code members, and gives it the crew's tools.
//
// It follows OpenCode's event stream (ctx.event.subscribe), keeps each member session's crew state
// with beat.ts, and writes the dashboard's beat file (~/.claude/crew/<sessionId>.json, the shape in
// types/index.d.ts) on every change and every 20 seconds. The member's name comes from CREW_NAME,
// which bin/crew sets; OpenCode must run --standalone so the plugin runs in that member's process.
//
// OpenCode evicts a location and boots the plugin again in the same process on a long idle member
// (#22). A reloaded plugin starts with empty state, so setup adopts the member session its own beat
// names, resumes the room cursor this member persisted, and its teardown never marks the member
// offline: only the process going away for good does that, through one module-level exit dispatcher.
//
// OpenCode connects MCP servers per location (#23): a member that touches a second directory (a
// session tab it restores, a project it resolves) would run a second macula-mcp under the same
// identity and the copies flap each other off the station. The config ships the macula entry
// disabled; setup enables it in the member's own directory (CREW_WORKDIR, where the launcher started
// the process) and leaves it out of every other location, so one member runs one macula-mcp.
//
// Loaded by bin/crew through OPENCODE_CONFIG_CONTENT ({"plugins": ["file://.../hosts/opencode"]}): OpenCode 2
// loads a plugin directory's `server` entry, this file.
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'

import { acceptEnvelope, fenceDelivery, roomRulesPrompt, type Roster } from '../../core/crew_room.ts'
import { rowToMessage, type TranscriptRow } from './room.ts'
import { LOG_EVENTS, PACKAGE_REF, apply, beatOf, fresh, isoWeek, ledgerLine, offline, parkPath, type Member, type Tracker, type Usage } from './beat.ts'

const BEAT_MS = 20_000
// CREW_DIR overrides where beats, the roster and the room live (tests and proofs; the crew uses the default).
const CREW_DIR = process.env.CREW_DIR || `${process.env.HOME || homedir()}/.claude/crew`
const NAME = process.env.CREW_NAME?.trim() || ''
const OWNER = process.env.CREW_OWNER?.trim() || 'the owner'
const SUPERVISOR = process.env.CREW_SUPERVISOR?.trim() || 'Supervisor'
// CREW_DEBUG=<file> traces what the plugin sees, one line per event, for checking it against an OpenCode release.
const trace = (line: string) => {
  if (process.env.CREW_DEBUG) appendFileSync(process.env.CREW_DEBUG, `${new Date().toISOString()} ${line}\n`)
}

// What OpenCode's plugin context gives this plugin; only the parts used, typed loosely because the
// v2 types are not published on npm (see README.md).
type Ctx = {
  location?: { directory?: string }
  event: { subscribe: () => AsyncIterable<{ type: string; data?: Record<string, unknown> }> }
  session: {
    get: (input: { sessionID: string }) => Promise<Record<string, unknown>>
    prompt: (input: { sessionID: string; text: string; delivery?: 'steer' | 'queue' }) => Promise<unknown>
    hook: (name: 'context', run: (event: { sessionID: string; system: { type: 'text'; text: string }[] }) => void) => Promise<unknown>
  }
  model?: { list?: () => Promise<unknown> }
  tool: { transform: (edit: (tools: { add: (tool: Record<string, unknown>) => void }) => void) => Promise<unknown> }
  mcp?: { transform: (edit: (editor: McpEditor) => void) => Promise<unknown> }
}

// The MCP editor's parts this plugin uses: the location's server table, writable from a transform.
type McpEditor = {
  update: (name: string, edit: (config: { disabled?: boolean }) => void) => void
  remove: (name: string) => void
}

const ROOM_POLL_MS = 10_000
// The transcript every macula-mcp process on this machine writes; the crew room's messages are in it as long as
// any crew session's macula server is in the room.
const TRANSCRIPT = process.env.MACULA_MCP_LOBBY_TRANSCRIPT_DB || `${process.env.HOME || homedir()}/.macula-mcp/lobby-transcript.sqlite3`

// Where the crew room's rows come from, by row id: the shared transcript in production, a memory-backed
// stand-in in tests. `max` is the cursor a brand-new member fixes at so it does not replay the room.
export type RoomSource = {
  max: (topic: string) => Promise<number>
  rows: (topic: string, afterId: number) => Promise<TranscriptRow[]>
}

// The transcript source: bun:sqlite, as OpenCode runs plugins under Bun; read-only, and opened per read so a
// missing file is no error (a transcript path that does not exist yet has no rows).
const transcriptSource = (path: string): RoomSource => ({
  max: async (topic: string) => {
    if (!existsSync(path)) return 0
    const { Database } = await import('bun:sqlite')
    const db = new Database(path, { readonly: true })
    try {
      return Number((db.query('SELECT COALESCE(MAX(id), 0) AS n FROM observed_facts WHERE topic = ?').get(topic) as { n: number }).n)
    } finally {
      db.close()
    }
  },
  rows: async (topic: string, afterId: number) => {
    if (!existsSync(path)) return []
    const { Database } = await import('bun:sqlite')
    const db = new Database(path, { readonly: true })
    try {
      return db.query('SELECT id, raw_json, publisher FROM observed_facts WHERE topic = ? AND id > ? ORDER BY id LIMIT 200').all(topic, afterId) as TranscriptRow[]
    } finally {
      db.close()
    }
  },
})

// What start() reads (all optional): the plugin (setup) lets the env defaults apply, tests inject a crew
// directory, a member name and a memory-backed room source.
export type StartOptions = {
  crewDir?: string
  name?: string
  owner?: string
  supervisor?: string
  roomSource?: RoomSource
  transcriptPath?: string
  beatMs?: number
  roomPollMs?: number
}

const readJson = (path: string) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

const boundary = () => Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('')

const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

const isParked = (crewDir: string, name: string) => name !== '' && existsSync(parkPath(crewDir, name))

// The repo as the dashboard names it (org/repo), read from the directory's git remote.
const repoOf = (directory: string) => {
  try {
    const url = execFileSync('git', ['-C', directory, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return url.replace(/^.*[:/]([^/]+\/[^/]+?)(\.git)?$/, '$1') || directory
  } catch {
    return directory
  }
}

// One macula-mcp per member (#23): OpenCode connects MCP servers per location, and it boots a location for
// every directory the process touches. The config ships the macula entry disabled; here the member's own
// directory (where bin/crew started this process, CREW_WORKDIR) enables it, and every other location drops
// it, so the member runs one mesh peer however many locations the process holds.
const sameDirectory = (a: string, b: string) => {
  const real = (path: string) => {
    try {
      return realpathSync.native(path)
    } catch {
      return resolve(path)
    }
  }
  return real(a) === real(b)
}
const scopeMacula = async (ctx: Ctx, directory: string, isHome: boolean) => {
  if (!ctx.mcp?.transform) return
  await ctx.mcp.transform((editor) => {
    if (isHome) editor.update('macula', (config) => { config.disabled = false })
    else editor.remove('macula')
  })
  trace(`macula ${isHome ? `enabled in ${directory}` : `left out of ${directory}`}`)
}

// The model's context window, by provider/model id, from ctx.model.list(); empty when it cannot be read.
const limitsOf = async (ctx: Ctx) => {
  const limits = new Map<string, number>()
  const listed = (await ctx.model?.list?.().catch(() => null)) as { data?: unknown } | unknown[] | null
  const models = (Array.isArray(listed) ? listed : Array.isArray(listed?.data) ? listed.data : []) as Record<string, unknown>[]
  for (const model of models) {
    const context = Number((model.limit as { context?: unknown } | undefined)?.context)
    const id = String(model.id ?? '')
    const provider = String(model.providerID ?? '')
    if (id && context > 0) limits.set(provider ? `${provider}/${id}` : id, context)
  }
  return limits
}

// Model, cost and context share of one member session, as far as OpenCode reports them. The context
// share needs the model's window from ctx.model.list(), which lists the catalog's models only (a
// provider declared in opencode.json alone is absent): null then.
const usageOf = async (ctx: Ctx, member: Member, limits: Map<string, number>): Promise<Usage & { startedAt: number }> => {
  const info = await ctx.session.get({ sessionID: member.sessionId }).catch(() => ({}) as Record<string, unknown>)
  const model = (info.model ?? {}) as { id?: string; providerID?: string }
  const modelName = model.id ? (model.providerID ? `${model.providerID}/${model.id}` : model.id) : ''
  const cost = Number(info.cost)
  const startedAt = Number((info.time as { created?: unknown } | undefined)?.created) || Date.now()
  const limit = limits.get(modelName)
  const contextPercent = limit && member.contextTokens > 0 ? Math.min(100, Math.round((member.contextTokens * 100) / limit)) : null
  return { model: modelName, costUsd: Number.isFinite(cost) ? cost : null, contextPercent, startedAt }
}

// One process-exit handler for the whole process, however many times OpenCode reloads the plugin (#22):
// each instance registers its own offline writer and removes it again on teardown, so a reload never
// stacks listeners and an evicted instance's teardown never marks a live member offline.
type OfflineWriter = () => void
const offlineWriters = new Set<OfflineWriter>()
let exitWired = false
const onProcessExit = () => {
  for (const writer of [...offlineWriters]) {
    try {
      writer()
    } catch {
      // The crew directory is gone: nothing to mark.
    }
  }
}
const registerOfflineOnExit = (writer: OfflineWriter) => {
  offlineWriters.add(writer)
  if (!exitWired) {
    exitWired = true
    process.once('exit', onProcessExit)
  }
  return () => void offlineWriters.delete(writer)
}

export default {
  id: 'crew',
  setup: async (ctx: Ctx) => {
    try {
      return await start(ctx)
    } catch (error) {
      trace(`setup failed: ${error instanceof Error ? `${error.message} ${error.stack ?? ''}` : String(error)}`)
      throw error
    }
  },
}

export const start = async (ctx: Ctx, options: StartOptions = {}) => {
  const crewDir = options.crewDir ?? CREW_DIR
  const name = options.name ?? NAME
  const owner = options.owner ?? OWNER
  const supervisor = options.supervisor ?? SUPERVISOR
  const beatMs = options.beatMs ?? BEAT_MS
  const roomPollMs = options.roomPollMs ?? ROOM_POLL_MS
  const source = options.roomSource ?? transcriptSource(options.transcriptPath ?? TRANSCRIPT)
  trace(`setup name=${name || '(none)'}`)
  if (name === '') return
  const directory = ctx.location?.directory ?? process.cwd()
  const ownLocation = sameDirectory(directory, process.env.CREW_WORKDIR?.trim() || process.cwd())
  await scopeMacula(ctx, directory, ownLocation).catch(error => trace(`macula scope failed: ${String(error)}`))
  const repo = repoOf(directory)
  let limits = await limitsOf(ctx)
  let tracker: Tracker = fresh()
  // The member session tools act on: the one that ran last, or the one setup adopted on a reload.
  let current = ''
  let roomRefused = 0

  // Each member session's last beat, for the offline beat written on exit.
  const lastBeats = new Map<string, Record<string, unknown>>()
  const beat = async (member: Member) => {
    if (limits.size === 0) limits = await limitsOf(ctx)
    const usage = await usageOf(ctx, member, limits)
    const at = { name, repo, isParked: isParked(crewDir, name), now: Date.now(), startedAt: usage.startedAt, usage }
    const written = { ...beatOf(member, at), roomRefused }
    lastBeats.set(member.sessionId, written)
    write(`${crewDir}/${member.sessionId}.json`, JSON.stringify(written))
    trace(`beat ${member.sessionId} ${member.state}`)
  }
  // On process exit (/exit, or the process going away) every member session's beat goes offline at once,
  // written synchronously because nothing async runs after 'exit'; signals stay OpenCode's (Ctrl+C
  // interrupts a turn). A plugin reload calls teardown, which unregisters this writer and never runs it.
  // A process killed outright writes nothing: bin/crew's is_live also checks the process. Last usage kept.
  const unregisterOffline = registerOfflineOnExit(() => {
    for (const member of Object.values(tracker.sessions)) {
      const held = lastBeats.get(member.sessionId)
      if (!held) continue
      writeFileSync(`${crewDir}/${member.sessionId}.json`, JSON.stringify({ ...held, state: offline(member).state, beatAt: Date.now() }))
    }
  })
  const beatAll = () => Promise.all(Object.values(tracker.sessions).map(beat)).catch(() => undefined)
  // OpenCode publishes no session.created for a session that existed before this plugin subscribed
  // (opencode run creates its session first), so a session first seen mid-stream is looked up once:
  // its parentID says whether it is a member's session or a subagent's.
  const adopt = async (sessionID: string) => {
    if (!sessionID || tracker.sessions[sessionID] || tracker.children[sessionID]) return
    const info = await ctx.session.get({ sessionID }).catch(() => ({}) as Record<string, unknown>)
    tracker = apply(tracker, { type: 'session.created', data: { sessionID, parentID: info.parentID, agent: info.agent, title: info.title } })
  }
  // A reloaded plugin has no session.created and no storage listing to lean on, so it adopts the member
  // session the crew's own beat names (#22): the newest beat for this member on this host, confirmed with
  // session.get to be a root (no parentID). With no such beat the member is brand new and `current` waits.
  const adoptExisting = async () => {
    let newest: { sessionID: string; beatAt: number } | null = null
    let entries: string[] = []
    try {
      entries = readdirSync(crewDir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      const held = readJson(`${crewDir}/${entry}`)
      if (!held || held.agent !== 'opencode' || held.name !== name) continue
      const sessionID = String(held.sessionId ?? entry.replace(/\.json$/, ''))
      if (!sessionID) continue
      const beatAt = Number(held.beatAt) || 0
      if (!newest || beatAt > newest.beatAt) newest = { sessionID, beatAt }
    }
    if (!newest) return
    const info = await ctx.session.get({ sessionID: newest.sessionID }).catch(() => null)
    if (!info || info.parentID) return
    tracker = apply(tracker, { type: 'session.created', data: { sessionID: newest.sessionID, parentID: info.parentID, agent: info.agent, title: info.title } })
    current = newest.sessionID
    const member = tracker.sessions[newest.sessionID]
    if (member) await beat(member).catch(error => trace(`adopt beat failed: ${String(error)}`))
    trace(`adopted session ${newest.sessionID}`)
  }
  const feed = async (event: { type: string; data?: Record<string, unknown> }) => {
    trace(`event ${event.type} ${JSON.stringify(event.data ?? {}).slice(0, 200)}`)
    if (event.type !== 'session.created' && event.type !== 'session.deleted' && typeof event.data?.sessionID === 'string') await adopt(event.data.sessionID)
    const before = tracker
    tracker = apply(tracker, { type: event.type, data: event.data ?? {} })
    if (tracker === before) return
    const id = String(event.data?.sessionID ?? '')
    const root = tracker.children[id]?.root ?? id
    if (tracker.sessions[root]) current = root
    if (event.type === 'session.deleted') rmSync(`${crewDir}/${id}.json`, { force: true })
    const member = tracker.sessions[root]
    if (member) await beat(member).catch(error => trace(`beat failed: ${String(error)}`))
  }

  const timer = setInterval(() => void beatAll(), beatMs)

  // The crew room (#18): delivered by core/crew_room.ts's rules, read from the shared transcript by row id.
  const roster = (readJson(`${crewDir}/roster.json`) ?? {}) as Roster
  const myId = roster[name] ?? ''
  const topic = String(readJson(`${crewDir}/room.json`)?.topic ?? '')
  // The room cursor is persisted per member (#22): a reload resumes exactly where the last instance
  // stopped, so a message that arrives across the gap is delivered once. A brand-new member has no
  // file and starts at MAX, replaying nothing.
  const cursorFile = `${crewDir}/opencode/room-${name}.json`
  const saved = readJson(cursorFile)
  let roomCursor = saved && String(saved.topic) === topic && Number.isFinite(Number(saved.cursor)) ? Number(saved.cursor) : -1
  const saveCursor = () => {
    if (!topic) return
    try {
      write(cursorFile, JSON.stringify({ topic, cursor: roomCursor }))
    } catch {
      // The crew directory is gone: the next instance starts at MAX again.
    }
  }
  // One read at a time: a slow read or prompt must not let the next poll read from the same cursor (#19).
  let watchingRoom = false
  const watchRoom = async () => {
    if (watchingRoom) return
    watchingRoom = true
    try {
      await readRoom()
    } finally {
      watchingRoom = false
    }
  }
  const readRoom = async () => {
    // One delivering instance per member (#19): every location OpenCode boots runs another plugin
    // instance with its own in-memory cursor, and each would deliver rows the others did too. The room
    // is delivered from the member's own location only, the one that also runs its macula server (#23).
    if (!ownLocation) return
    if (!topic || !myId) return
    if (roomCursor < 0) {
      // A fresh member does not replay the room's history; a reload resumes from its saved cursor.
      roomCursor = await source.max(topic)
      saveCursor()
      return
    }
    // No member session yet: nothing to deliver to, so the cursor waits too.
    if (!current) return
    const rows = await source.rows(topic, roomCursor)
    if (rows.length > 0) trace(`room read after ${roomCursor}: ${rows.map(row => row.id).join(',')}`)
    for (const row of rows) {
      roomCursor = row.id
      const message = rowToMessage(row)
      if (!message) continue
      const accepted = acceptEnvelope(message, { me: myId, roster, supervisor })
      if (!accepted.deliver) {
        // Same rule as the Claude mod (#20): only a forgery or a stranger counts; its own, another member's
        // and lifecycle envelopes are ordinary traffic.
        if (accepted.reason === 'unattested' || accepted.reason === 'not_on_roster') roomRefused += 1
        continue
      }
      // One turn per row, whatever overlaps (#19): the claim file is the atomic gate two instances
      // cannot both pass, and it survives a reload, so a lagging instance cannot deliver the row again.
      // Keyed by member as well: members share the crew directory, and an id another member already
      // claimed must not silence this member's copy.
      const claim = `${crewDir}/opencode/delivered/${name}/${message.message_id}`
      mkdirSync(dirname(claim), { recursive: true })
      try {
        writeFileSync(claim, '', { flag: 'wx' })
      } catch (error) {
        if ((error as { code?: string }).code === 'EEXIST') continue
        throw error
      }
      trace(`room delivers ${message.message_id} from ${accepted.sender}`)
      try {
        await ctx.session.prompt({ sessionID: current, text: fenceDelivery(message, accepted, { boundary: boundary(), owner, supervisor }), delivery: 'queue' })
      } catch (error) {
        rmSync(claim, { force: true })
        throw error
      }
    }
    if (rows.length > 0) saveCursor()
    if (roomRefused > 0) trace(`room refused ${roomRefused}`)
  }
  // Adopt before the first room read: an idle member that was reloaded already has a session, and its saved
  // cursor must resume into it (#22).
  await adoptExisting().catch(error => trace(`adopt failed: ${String(error)}`))
  const roomTimer = setInterval(() => void watchRoom().catch(error => trace(`room watch failed: ${String(error)}`)), roomPollMs)
  void watchRoom().catch(() => undefined)
  const rules = topic && myId
    ? roomRulesPrompt({ topic, roster, supervisor, owner })
    : 'Crew room: none for this session (no room.json from the Supervisor, or this member is not in roster.json, which bin/crew writes).'
  await ctx.session.hook('context', event => {
    if (!tracker.children[event.sessionID]) event.system.push({ type: 'text', text: rules })
  }).catch(error => trace(`room rules not added: ${String(error)}`))
  const stream = (async () => {
    for await (const event of ctx.event.subscribe()) await feed(event)
  })().catch(error => trace(`event stream ended: ${String(error)}`))

  const ledger = (entry: { event: string; package: string; note?: string }) => {
    const at = Date.now()
    const path = `${crewDir}/ledger/${isoWeek(at)}/${current || 'opencode'}.jsonl`
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${ledgerLine(entry, name, at, null)}\n`)
  }

  await ctx.tool.transform(tools => {
    tools.add({
      name: 'report_progress',
      options: { codemode: false },
      description:
        `Report progress on your current assigned task to the crew dashboard ${owner} watches. ` +
        'Call it when you start a task (step 0), after each meaningful step, and once when done (step equal to of). ' +
        'Returns nothing useful; carry on with your work.',
      input: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The task, short: under 60 characters, naming the outcome' },
          step: { type: 'integer', minimum: 0, description: 'Steps completed so far' },
          of: { type: 'integer', minimum: 1, description: 'Total steps, your best current estimate; revise it as you learn' },
          phase: { type: 'string', enum: ['reviewing', 'working'], description: "reviewing while you review work (yours or another's), working when you are back at it" },
        },
        required: ['task', 'step', 'of'],
      },
      execute: async (input: Record<string, unknown>, context: { sessionID: string }) => {
        await feed({ type: 'crew.progress', data: { ...input, sessionID: context.sessionID, at: Date.now() } })
        const progress = tracker.sessions[tracker.children[context.sessionID]?.root ?? context.sessionID]?.progress
        return { content: progress ? `Progress noted: ${progress.step}/${progress.of} ${progress.task}` : 'Progress noted.' }
      },
    })
    tools.add({
      name: 'crew_park',
      options: { codemode: false },
      description:
        `Park or unpark this session on the crew dashboard ${owner} watches. A parked member is never woken on idle. ` +
        `Call it with parked 1 when the ${supervisor} or ${owner} tells you to stop or wind down, and with parked 0 when told to resume.`,
      input: {
        type: 'object',
        properties: {
          parked: { type: 'integer', enum: [0, 1], description: '1 parks this session, 0 unparks it' },
          reason: { type: 'string', description: 'Who told you to stop or resume, and why, in one line' },
        },
        required: ['parked', 'reason'],
      },
      execute: async (input: { parked?: unknown; reason?: unknown }) => {
        const parked = Number(input.parked) === 1
        const reason = String(input.reason ?? '').slice(0, 160)
        parked ? write(parkPath(crewDir, name), reason) : rmSync(parkPath(crewDir, name), { force: true })
        await beatAll()
        return { content: parked ? `${name} is parked (${reason}): wake-on-idle no longer wakes it. End your turn.` : `${name} is unparked (${reason}): wake-on-idle wakes it again to work the board.` }
      },
    })
    tools.add({
      name: 'crew_log',
      options: { codemode: false },
      description:
        `Log a work package milestone in the crew's ledger, which ${owner} reads to tune the crew for cost and speed. ` +
        'Members log checkpoint, release, fix_after_ship, fable_round.',
      input: {
        type: 'object',
        properties: {
          package: { type: 'string', description: 'The work package, org/repo#n' },
          event: { type: 'string', enum: LOG_EVENTS, description: 'What happened' },
          note: { type: 'string', description: 'One short line: the range, the release, why it was sent back' },
        },
        required: ['package', 'event'],
      },
      execute: async (input: { package?: unknown; event?: unknown; note?: unknown }) => {
        const event = String(input.event ?? '')
        const ref = String(input.package ?? '').trim()
        if (!LOG_EVENTS.includes(event)) return { content: `Not logged: event must be one of ${LOG_EVENTS.join(', ')}.` }
        if (!PACKAGE_REF.test(ref)) return { content: 'Not logged: package must be a work package ref, org/repo#n.' }
        ledger({ event, package: ref, note: String(input.note ?? '').slice(0, 200) })
        return { content: `${event} logged for ${ref}.` }
      },
    })
    tools.add({
      name: 'queue_ask',
      options: { codemode: false },
      description:
        `Queue a routine yes/no ask for ${owner} instead of asking it now: a cleanup, a branch or worktree to delete. ` +
        `The ${supervisor} offers queued asks together. Never queue part of a change.`,
      input: {
        type: 'object',
        properties: { ask: { type: 'string', description: 'The question, answerable yes or no, naming exactly what would be done' } },
        required: ['ask'],
      },
      execute: async (input: { ask?: unknown }, context: { sessionID: string }) => {
        const ask = String(input.ask ?? '').trim().slice(0, 300)
        if (ask === '') return { content: 'Nothing queued: the ask is empty.' }
        const at = Date.now()
        const id = `${String(at).padStart(15, '0')}-${context.sessionID.slice(-8)}-${Math.random().toString(36).slice(2, 8)}`
        write(`${crewDir}/asks/${id}.json`, JSON.stringify({ from: name, ask, at }))
        return { content: `Queued for ${owner}. Do not ask it now; carry on.` }
      },
    })
    tools.add({
      name: 'crew_restart',
      options: { codemode: false },
      description:
        'Restart a crew member headless: stop it cleanly (its own process group) and start it again in a detached tmux session, no kitty needed. ' +
        `For the ${supervisor}: use it when a member is stalled or a fix needs a relaunch. ${owner}'s approval is needed for pushes, tags and fleet changes, not for member restarts.`,
      input: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The member to restart' },
          reason: { type: 'string', description: 'Why, in one line' },
          fresh: { type: 'integer', enum: [0, 1], description: '1 starts a fresh session (drops its context), 0 resumes the last one' },
        },
        required: ['name', 'reason', 'fresh'],
      },
      execute: async (input: { name?: unknown; reason?: unknown; fresh?: unknown }) => {
        const member = String(input.name ?? '').trim()
        if (!/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/.test(member)) {
          return { content: 'Not restarted: name must be a plain member name (letters, digits, _ and -).' }
        }
        const fresh = Number(input.fresh) === 1
        // The launcher's own path comes in on the launch env; a checkout's sibling bin/crew covers a
        // session started by hand.
        const launcher = process.env.CREW_BIN?.trim() || resolve(import.meta.dirname ?? '.', '..', '..', 'bin', 'crew')
        try {
          const out = execFileSync(launcher, ['restart', member, ...(fresh ? ['--fresh'] : [])], { encoding: 'utf8', timeout: 120_000 })
          const tail = out.trim().split('\n').filter(Boolean).at(-1) ?? ''
          return { content: `${member} restarted${fresh ? ' fresh' : ''}.${tail ? ` ${tail}` : ''}` }
        } catch (error) {
          const stderr = String((error as { stderr?: string }).stderr ?? '').trim().split('\n').filter(Boolean).at(-1)
          return { content: `Not restarted: ${stderr || (error instanceof Error ? error.message : String(error))}` }
        }
      },
    })
  })

  return async () => {
    clearInterval(timer)
    clearInterval(roomTimer)
    // A reload (#22) never marks the member offline; the exit dispatcher above does that, and only when
    // the process is really going away.
    unregisterOffline()
    void stream
  }
}
