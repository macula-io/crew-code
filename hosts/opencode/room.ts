// The OpenCode adapter's reading of the crew room (crew-code#18). The plugin cannot call MCP tools, so it reads
// the transcript every macula-mcp process on the machine writes (~/.macula-mcp/lobby-transcript.sqlite3,
// table observed_facts). This turns one row into the message core/crew_room.ts judges: `attested` comes from
// the row's `publisher`, which the station reported, never from the envelope's own claim.
import type { RoomMessage } from '../../core/crew_room.ts'

export type TranscriptRow = { id: number; raw_json: string; publisher: string | null }

const HEX32 = /^[0-9a-f]{32}$/
const HEX64 = /^[0-9a-f]{64}$/i

export const rowToMessage = (row: TranscriptRow): RoomMessage | null => {
  let env: Record<string, unknown>
  try {
    env = JSON.parse(row.raw_json) as Record<string, unknown>
  } catch {
    return null
  }
  if (typeof env !== 'object' || env === null) return null
  const { message_id: id, from, kind, text, to, in_reply_to: replyTo } = env
  if (typeof id !== 'string' || !HEX32.test(id) || typeof from !== 'string' || !HEX64.test(from)) return null
  if (typeof kind !== 'string' || typeof text !== 'string') return null
  // As macula-mcp's parseEnvelope: a malformed `to` is no message, never "to everyone".
  if (to !== undefined && !(Array.isArray(to) && to.length >= 1 && to.length <= 32 && to.every(n => typeof n === 'string' && HEX64.test(n)))) return null
  const sender = from.toLowerCase()
  return {
    message_id: id,
    from: sender,
    kind,
    text,
    ...(to !== undefined ? { to: (to as string[]).map(n => n.toLowerCase()) } : {}),
    ...(typeof replyTo === 'string' && HEX32.test(replyTo) ? { in_reply_to: replyTo } : {}),
    attested: typeof row.publisher === 'string' && row.publisher.toLowerCase() === sender ? 1 : 0,
    seq: row.id,
  }
}
