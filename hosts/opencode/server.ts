// crew for OpenCode (v2 plugin API, OpenCode 2.x): puts an OpenCode member on the same crew
// dashboard as the Claude Code members, and gives it the crew's tools.
//
// It follows OpenCode's event stream (ctx.event.subscribe), keeps each member session's crew state
// with beat.ts, and writes the dashboard's beat file (~/.claude/crew/<sessionId>.json, the shape in
// types/index.d.ts) on every change and every 20 seconds. The member's name comes from CREW_NAME,
// which bin/crew sets; OpenCode must run --standalone so the plugin runs in that member's process.
//
// Loaded by bin/crew through OPENCODE_CONFIG_CONTENT ({"plugins": ["file://.../hosts/opencode"]}): OpenCode 2
// loads a plugin directory's `server` entry, this file.
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'

import { LOG_EVENTS, PACKAGE_REF, apply, beatOf, fresh, isoWeek, ledgerLine, parkPath, type Member, type Tracker, type Usage } from './beat.ts'

const BEAT_MS = 20_000
const CREW_DIR = `${process.env.HOME || homedir()}/.claude/crew`
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
  }
  model?: { list?: () => Promise<unknown> }
  tool: { transform: (edit: (tools: { add: (tool: Record<string, unknown>) => void }) => void) => Promise<unknown> }
}

const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

const isParked = () => NAME !== '' && existsSync(parkPath(CREW_DIR, NAME))

// The repo as the dashboard names it (org/repo), read from the directory's git remote.
const repoOf = (directory: string) => {
  try {
    const url = execFileSync('git', ['-C', directory, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return url.replace(/^.*[:/]([^/]+\/[^/]+?)(\.git)?$/, '$1') || directory
  } catch {
    return directory
  }
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

const start = async (ctx: Ctx) => {
  trace(`setup name=${NAME || '(none)'}`)
    if (NAME === '') return
    const directory = ctx.location?.directory ?? process.cwd()
    const repo = repoOf(directory)
    let limits = await limitsOf(ctx)
    let tracker: Tracker = fresh()
    // The member session tools act on: the one that ran last.
    let current = ''

    const beat = async (member: Member) => {
      if (limits.size === 0) limits = await limitsOf(ctx)
      const usage = await usageOf(ctx, member, limits)
      const at = { name: NAME, repo, isParked: isParked(), now: Date.now(), startedAt: usage.startedAt, usage }
      write(`${CREW_DIR}/${member.sessionId}.json`, JSON.stringify(beatOf(member, at)))
      trace(`beat ${member.sessionId} ${member.state}`)
    }
    const beatAll = () => Promise.all(Object.values(tracker.sessions).map(beat)).catch(() => undefined)
    // OpenCode publishes no session.created for a session that existed before this plugin subscribed
    // (opencode run creates its session first), so a session first seen mid-stream is looked up once:
    // its parentID says whether it is a member's session or a subagent's.
    const adopt = async (sessionID: string) => {
      if (!sessionID || tracker.sessions[sessionID] || tracker.children[sessionID]) return
      const info = await ctx.session.get({ sessionID }).catch(() => ({}) as Record<string, unknown>)
      tracker = apply(tracker, { type: 'session.created', data: { sessionID, parentID: info.parentID, agent: info.agent, title: info.title } })
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
      if (event.type === 'session.deleted') rmSync(`${CREW_DIR}/${id}.json`, { force: true })
      const member = tracker.sessions[root]
      if (member) await beat(member).catch(error => trace(`beat failed: ${String(error)}`))
    }

    const timer = setInterval(() => void beatAll(), BEAT_MS)
    const stream = (async () => {
      for await (const event of ctx.event.subscribe()) await feed(event)
    })().catch(error => trace(`event stream ended: ${String(error)}`))

    const ledger = (entry: { event: string; package: string; note?: string }) => {
      const at = Date.now()
      const path = `${CREW_DIR}/ledger/${isoWeek(at)}/${current || 'opencode'}.jsonl`
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, `${ledgerLine(entry, NAME, at, null)}\n`)
    }

    await ctx.tool.transform(tools => {
      tools.add({
        name: 'report_progress',
        options: { codemode: false },
        description:
          `Report progress on your current assigned task to the crew dashboard ${OWNER} watches. ` +
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
          return { output: progress ? `Progress noted: ${progress.step}/${progress.of} ${progress.task}` : 'Progress noted.' }
        },
      })
      tools.add({
        name: 'crew_park',
        options: { codemode: false },
        description:
          `Park or unpark this session on the crew dashboard ${OWNER} watches. A parked member is never woken on idle. ` +
          `Call it with parked 1 when the ${SUPERVISOR} or ${OWNER} tells you to stop or wind down, and with parked 0 when told to resume.`,
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
          parked ? write(parkPath(CREW_DIR, NAME), reason) : rmSync(parkPath(CREW_DIR, NAME), { force: true })
          await beatAll()
          return { output: parked ? `${NAME} is parked (${reason}): wake-on-idle no longer wakes it. End your turn.` : `${NAME} is unparked (${reason}): wake-on-idle wakes it again to work the board.` }
        },
      })
      tools.add({
        name: 'crew_log',
        options: { codemode: false },
        description:
          `Log a work package milestone in the crew's ledger, which ${OWNER} reads to tune the crew for cost and speed. ` +
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
          if (!LOG_EVENTS.includes(event)) return { output: `Not logged: event must be one of ${LOG_EVENTS.join(', ')}.` }
          if (!PACKAGE_REF.test(ref)) return { output: 'Not logged: package must be a work package ref, org/repo#n.' }
          ledger({ event, package: ref, note: String(input.note ?? '').slice(0, 200) })
          return { output: `${event} logged for ${ref}.` }
        },
      })
      tools.add({
        name: 'queue_ask',
        options: { codemode: false },
        description:
          `Queue a routine yes/no ask for ${OWNER} instead of asking it now: a cleanup, a branch or worktree to delete. ` +
          `The ${SUPERVISOR} offers queued asks together. Never queue part of a change.`,
        input: {
          type: 'object',
          properties: { ask: { type: 'string', description: 'The question, answerable yes or no, naming exactly what would be done' } },
          required: ['ask'],
        },
        execute: async (input: { ask?: unknown }, context: { sessionID: string }) => {
          const ask = String(input.ask ?? '').trim().slice(0, 300)
          if (ask === '') return { output: 'Nothing queued: the ask is empty.' }
          const at = Date.now()
          const id = `${String(at).padStart(15, '0')}-${context.sessionID.slice(-8)}-${Math.random().toString(36).slice(2, 8)}`
          write(`${CREW_DIR}/asks/${id}.json`, JSON.stringify({ from: NAME, ask, at }))
          return { output: `Queued for ${OWNER}. Do not ask it now; carry on.` }
        },
      })
    })

    return async () => {
      clearInterval(timer)
      await beatAll()
      void stream
    }
}
