// The OpenCode adapter's reading of the crew room (crew-code#18): a row of the shared macula-mcp transcript
// becomes a room message only with the station's own publisher as its attestation. Run:
// node --test hosts/opencode/room.node-test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { rowToMessage } from './room.ts'

const VENUS = 'c'.repeat(64)
const PLUTO = 'b'.repeat(64)
const envelope = (over: Record<string, unknown> = {}) => JSON.stringify({
  message_id: '1'.repeat(32), room_topic: `agents.room.${'9'.repeat(32)}`, sent_at: 1, from: VENUS.toUpperCase(),
  kind: 'question_asked', text: 'ready?', to: [PLUTO.toUpperCase()], ...over,
})

test('a row whose station publisher is the envelope\'s sender is attested; ids are lowercased; seq is the row id', () => {
  assert.deepEqual(rowToMessage({ id: 42, raw_json: envelope(), publisher: VENUS }), {
    message_id: '1'.repeat(32), from: VENUS, kind: 'question_asked', text: 'ready?', to: [PLUTO], attested: 1, seq: 42,
  })
})

test('a row published by someone else, or with no publisher recorded, is not attested', () => {
  assert.equal(rowToMessage({ id: 1, raw_json: envelope(), publisher: PLUTO })?.attested, 0)
  assert.equal(rowToMessage({ id: 1, raw_json: envelope(), publisher: null })?.attested, 0)
})

test('a row that is not an envelope, or whose to is malformed, is no message', () => {
  assert.equal(rowToMessage({ id: 1, raw_json: 'not json', publisher: VENUS }), null)
  assert.equal(rowToMessage({ id: 1, raw_json: JSON.stringify({ hello: 1 }), publisher: VENUS }), null)
  assert.equal(rowToMessage({ id: 1, raw_json: envelope({ to: ['bob'] }), publisher: VENUS }), null)
  assert.equal(rowToMessage({ id: 1, raw_json: envelope({ to: [] }), publisher: VENUS }), null)
})

test('a reply keeps its in_reply_to', () => {
  const reply = rowToMessage({ id: 2, raw_json: envelope({ kind: 'answer_given', in_reply_to: 'e'.repeat(32) }), publisher: VENUS })
  assert.equal(reply?.in_reply_to, 'e'.repeat(32))
})
