import { expect, test } from 'bun:test'

import {
  HEADER_BYTES,
  decodeFrame,
  decodeHeader,
  encodeFrame,
  isPeerId,
  isRelayRoomId,
  type RelayFrame
} from '@/app/collab/transport/relay/frame'

const ALICE = '0a'.repeat(16)
const BOB = '0b'.repeat(16)

const HELLO = {
  kind: 'hello',
  senderId: ALICE,
  targetId: null,
  roomId: 'room_id-0123456789'
} as const satisfies RelayFrame
const ACTION = {
  kind: 'action',
  senderId: ALICE,
  targetId: BOB,
  chunk: {
    namespace: 'yjs-update',
    messageId: 0xffffffff,
    index: 2,
    count: 3,
    totalLength: 600,
    data: new Uint8Array([1, 2, 3])
  }
} as const satisfies RelayFrame
const PING = { kind: 'ping', senderId: ALICE, targetId: null } as const satisfies RelayFrame

const frames: RelayFrame[] = [
  HELLO,
  { kind: 'welcome', senderId: ALICE, targetId: BOB },
  { kind: 'leave', senderId: ALICE, targetId: null },
  PING,
  { kind: 'pong', senderId: ALICE, targetId: null },
  ACTION
]

test('every frame kind survives a round trip', () => {
  for (const frame of frames) expect(decodeFrame(encodeFrame(frame))).toEqual(frame)
})

test('the header routes without reading the payload', () => {
  const bytes = encodeFrame(ACTION)
  expect(decodeHeader(bytes)).toEqual({ kind: 'action', senderId: ALICE, targetId: BOB })
  expect(decodeHeader(bytes.subarray(0, HEADER_BYTES - 1))).toBeNull()
})

test('peer and room ids are checked on both sides', () => {
  expect(isPeerId(ALICE)).toBe(true)
  expect(isPeerId('00'.repeat(16))).toBe(false)
  expect(isPeerId('0A'.repeat(16))).toBe(false)
  expect(isPeerId('0a'.repeat(15))).toBe(false)
  expect(isRelayRoomId('a'.repeat(16))).toBe(true)
  expect(isRelayRoomId('a'.repeat(15))).toBe(false)
  expect(isRelayRoomId('a'.repeat(129))).toBe(false)
  expect(isRelayRoomId(`${'a'.repeat(16)}/`)).toBe(false)

  expect(() => encodeFrame({ ...PING, senderId: 'x' })).toThrow()
  expect(() => encodeFrame({ ...PING, targetId: 'x' })).toThrow()
  expect(() => encodeFrame({ ...HELLO, roomId: 'short' })).toThrow()
  expect(() => encodeFrame({ ...ACTION, chunk: { ...ACTION.chunk, namespace: '' } })).toThrow()
  expect(() =>
    encodeFrame({ ...ACTION, chunk: { ...ACTION.chunk, namespace: 'n'.repeat(256) } })
  ).toThrow()
})

test('malformed frames decode to null', () => {
  const hello = encodeFrame(HELLO)
  const action = encodeFrame(ACTION)
  const withByte = (bytes: Uint8Array, index: number, value: number) => {
    const copy = bytes.slice()
    copy[index] = value
    return copy
  }

  expect(decodeFrame(new Uint8Array())).toBeNull()
  expect(decodeFrame(withByte(hello, 0, 2))).toBeNull()
  expect(decodeFrame(withByte(hello, 1, 99))).toBeNull()
  expect(decodeFrame(new Uint8Array([1, 3, ...new Uint8Array(32)]))).toBeNull()
  expect(decodeFrame(withByte(hello, hello.length - 1, 0x2f))).toBeNull()
  expect(decodeFrame(hello.subarray(0, -1))).toBeNull()
  expect(decodeFrame(new Uint8Array([...encodeFrame(PING), 0]))).toBeNull()
  expect(decodeFrame(action.subarray(0, HEADER_BYTES + 5))).toBeNull()
  expect(decodeFrame(withByte(action, HEADER_BYTES + 1, 0xff))).toBeNull()
})
