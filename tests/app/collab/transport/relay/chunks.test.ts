import { expect, test } from 'bun:test'

import {
  MAX_MESSAGE_BYTES,
  MessageAssembler,
  splitMessage
} from '@/app/collab/transport/relay/chunks'

const ALICE = '0a'.repeat(16)
const BOB = '0b'.repeat(16)

function bytes(length: number, seed = 0): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i + seed) % 251)
}

function reassemble(
  assembler: MessageAssembler,
  sender: string,
  chunks: ReturnType<typeof splitMessage>
) {
  const results = chunks.map((chunk) => assembler.add(sender, chunk))
  expect(results.slice(0, -1).every((result) => result === null)).toBe(true)
  return results.at(-1)
}

test('a message splits into chunks and comes back whole', () => {
  const data = bytes(10)
  const chunks = splitMessage('doc', 7, data, 4)
  expect(chunks.map((chunk) => [chunk.index, chunk.count, chunk.data.length])).toEqual([
    [0, 3, 4],
    [1, 3, 4],
    [2, 3, 2]
  ])
  expect(reassemble(new MessageAssembler(), ALICE, chunks)).toEqual(data)
})

test('an empty message is one empty chunk', () => {
  const chunks = splitMessage('doc', 0, new Uint8Array())
  expect(chunks).toHaveLength(1)
  expect(new MessageAssembler().add(ALICE, chunks[0])).toEqual(new Uint8Array())
})

test('senders reassemble independently', () => {
  const assembler = new MessageAssembler()
  const fromAlice = splitMessage('doc', 1, bytes(9, 1), 3)
  const fromBob = splitMessage('doc', 1, bytes(9, 2), 3)
  expect(assembler.add(ALICE, fromAlice[0])).toBeNull()
  expect(assembler.add(BOB, fromBob[0])).toBeNull()
  expect(assembler.add(ALICE, fromAlice[1])).toBeNull()
  expect(assembler.add(BOB, fromBob[1])).toBeNull()
  expect(assembler.add(BOB, fromBob[2])).toEqual(bytes(9, 2))
  expect(assembler.add(ALICE, fromAlice[2])).toEqual(bytes(9, 1))
})

test('a chunk out of order drops the message', () => {
  const assembler = new MessageAssembler()
  const chunks = splitMessage('doc', 1, bytes(9), 3)
  assembler.add(ALICE, chunks[0])
  expect(assembler.add(ALICE, chunks[2])).toBeNull()
  expect(assembler.add(ALICE, chunks[1])).toBeNull()

  const other = splitMessage('doc', 2, bytes(9), 3)
  assembler.add(ALICE, chunks[0])
  expect(assembler.add(ALICE, other[1])).toBeNull()
  expect(assembler.add(ALICE, { ...chunks[1], namespace: 'awareness' })).toBeNull()
})

test('a new first chunk replaces an unfinished message', () => {
  const assembler = new MessageAssembler()
  const abandoned = splitMessage('doc', 1, bytes(9), 3)
  const next = splitMessage('doc', 2, bytes(6, 5), 3)
  assembler.add(ALICE, abandoned[0])
  expect(reassemble(assembler, ALICE, next)).toEqual(bytes(6, 5))
})

test('forget drops a sender part way through', () => {
  const assembler = new MessageAssembler()
  const chunks = splitMessage('doc', 1, bytes(6), 3)
  assembler.add(ALICE, chunks[0])
  assembler.forget(ALICE)
  expect(assembler.add(ALICE, chunks[1])).toBeNull()
})

test('claimed lengths are not trusted', () => {
  const assembler = new MessageAssembler()
  const base = splitMessage('doc', 1, bytes(4), 2)[0]
  expect(assembler.add(ALICE, { ...base, count: 0 })).toBeNull()
  expect(assembler.add(ALICE, { ...base, totalLength: MAX_MESSAGE_BYTES + 1 })).toBeNull()
  expect(assembler.add(ALICE, { ...base, count: 5, totalLength: 4 })).toBeNull()
  // More bytes than claimed, or fewer by the last chunk, is never delivered.
  expect(assembler.add(ALICE, { ...base, count: 1, totalLength: 1 })).toBeNull()
  expect(assembler.add(ALICE, { ...base, count: 1, totalLength: 3, data: bytes(2) })).toBeNull()
  expect(() => splitMessage('doc', 1, new Uint8Array(MAX_MESSAGE_BYTES + 1))).toThrow()
})

test('reassembly copies chunks so a reused buffer cannot change the result', () => {
  const assembler = new MessageAssembler()
  const buffer = bytes(4)
  const chunks = splitMessage('doc', 1, buffer, 2)
  assembler.add(ALICE, chunks[0])
  buffer.fill(0)
  expect(assembler.add(ALICE, chunks[1])).toEqual(new Uint8Array([0, 1, 0, 0]))
})
