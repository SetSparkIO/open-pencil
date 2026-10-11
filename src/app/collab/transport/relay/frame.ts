/**
 * Binary frames spoken between the relay transport (`./client`) and the collaboration relay
 * (`tools/dev/collab-relay`). Every frame starts with the same header so the relay can route
 * it without reading the payload:
 *
 *   byte 0       version (1)
 *   byte 1       kind
 *   bytes 2–17   sender peer id
 *   bytes 18–33  target peer id, all zeros for the whole room
 *
 * A hello carries the room id (one length byte, then ASCII) so the id stays out of the URL and
 * out of access logs. An action carries one chunk of a message (`./chunks`): one length byte and
 * the UTF-8 namespace, then message id, chunk index, chunk count and total length as little-endian
 * u32, then the chunk bytes.
 */

export const FRAME_VERSION = 1
export const PEER_ID_BYTES = 16
export const HEADER_BYTES = 2 + PEER_ID_BYTES * 2

/** Room ids typed into Join are accepted as long as they cannot smuggle anything else. */
export const RELAY_ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/

const PEER_ID_PATTERN = /^[0-9a-f]{32}$/
const BROADCAST_ID = '0'.repeat(PEER_ID_BYTES * 2)
const ACTION_FIELDS_BYTES = 16
const MAX_NAMESPACE_BYTES = 255

export const FRAME_KIND = {
  hello: 1,
  welcome: 2,
  leave: 3,
  action: 4,
  ping: 5,
  pong: 6
} as const

export type FrameKind = keyof typeof FRAME_KIND

const KIND_BY_CODE = new Map<number, FrameKind>(
  Object.entries(FRAME_KIND).map(([kind, code]) => [code, kind as FrameKind])
)

export interface FrameHeader {
  kind: FrameKind
  senderId: string
  /** Null when the frame is for everyone in the room. */
  targetId: string | null
}

export interface ActionChunk {
  namespace: string
  messageId: number
  index: number
  count: number
  totalLength: number
  data: Uint8Array
}

export type RelayFrame =
  | (FrameHeader & { kind: 'hello'; roomId: string })
  | (FrameHeader & { kind: 'welcome' | 'leave' | 'ping' | 'pong' })
  | (FrameHeader & { kind: 'action'; chunk: ActionChunk })

export function isPeerId(value: string): boolean {
  return PEER_ID_PATTERN.test(value) && value !== BROADCAST_ID
}

export function isRelayRoomId(value: string): boolean {
  return RELAY_ROOM_ID_PATTERN.test(value)
}

function writePeerId(bytes: Uint8Array, offset: number, id: string | null) {
  if (id === null) return
  if (!isPeerId(id)) throw new Error('Invalid collaboration peer id')
  for (let i = 0; i < PEER_ID_BYTES; i++) {
    bytes[offset + i] = Number.parseInt(id.slice(i * 2, i * 2 + 2), 16)
  }
}

function readPeerId(bytes: Uint8Array, offset: number): string {
  let id = ''
  for (let i = 0; i < PEER_ID_BYTES; i++) {
    id += bytes[offset + i].toString(16).padStart(2, '0')
  }
  return id
}

function frame(header: FrameHeader, payloadLength: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(HEADER_BYTES + payloadLength)
  bytes[0] = FRAME_VERSION
  bytes[1] = FRAME_KIND[header.kind]
  writePeerId(bytes, 2, header.senderId)
  writePeerId(bytes, 2 + PEER_ID_BYTES, header.targetId)
  return bytes
}

/** A fresh buffer, so it can go straight to `WebSocket.send`. */
export function encodeFrame(value: RelayFrame): Uint8Array<ArrayBuffer> {
  if (value.kind === 'hello') {
    if (!isRelayRoomId(value.roomId)) throw new Error('Invalid collaboration room id')
    const bytes = frame(value, 1 + value.roomId.length)
    bytes[HEADER_BYTES] = value.roomId.length
    for (let i = 0; i < value.roomId.length; i++) {
      bytes[HEADER_BYTES + 1 + i] = value.roomId.charCodeAt(i)
    }
    return bytes
  }
  if (value.kind !== 'action') return frame(value, 0)

  const { chunk } = value
  const namespace = new TextEncoder().encode(chunk.namespace)
  if (namespace.length === 0 || namespace.length > MAX_NAMESPACE_BYTES) {
    throw new Error('Invalid collaboration action namespace')
  }
  const bytes = frame(value, 1 + namespace.length + ACTION_FIELDS_BYTES + chunk.data.length)
  let offset = HEADER_BYTES
  bytes[offset++] = namespace.length
  bytes.set(namespace, offset)
  offset += namespace.length
  const view = new DataView(bytes.buffer)
  view.setUint32(offset, chunk.messageId, true)
  view.setUint32(offset + 4, chunk.index, true)
  view.setUint32(offset + 8, chunk.count, true)
  view.setUint32(offset + 12, chunk.totalLength, true)
  bytes.set(chunk.data, offset + ACTION_FIELDS_BYTES)
  return bytes
}

/** Reads only the header; the relay routes on this and never looks at an action's payload. */
export function decodeHeader(bytes: Uint8Array): FrameHeader | null {
  if (bytes.length < HEADER_BYTES || bytes[0] !== FRAME_VERSION) return null
  const kind = KIND_BY_CODE.get(bytes[1])
  if (!kind) return null
  const senderId = readPeerId(bytes, 2)
  if (senderId === BROADCAST_ID) return null
  const target = readPeerId(bytes, 2 + PEER_ID_BYTES)
  return { kind, senderId, targetId: target === BROADCAST_ID ? null : target }
}

export function decodeFrame(bytes: Uint8Array): RelayFrame | null {
  const header = decodeHeader(bytes)
  if (!header) return null

  if (header.kind === 'hello') {
    if (bytes.length <= HEADER_BYTES) return null
    if (bytes.length !== HEADER_BYTES + 1 + bytes[HEADER_BYTES]) return null
    const roomId = String.fromCharCode(...bytes.subarray(HEADER_BYTES + 1))
    return isRelayRoomId(roomId) ? { ...header, kind: 'hello', roomId } : null
  }
  if (header.kind !== 'action') {
    return bytes.length === HEADER_BYTES ? { ...header, kind: header.kind } : null
  }

  const namespaceLength = bytes[HEADER_BYTES]
  if (!namespaceLength) return null
  const fieldsOffset = HEADER_BYTES + 1 + namespaceLength
  const dataOffset = fieldsOffset + ACTION_FIELDS_BYTES
  if (bytes.length < dataOffset) return null
  let namespace: string
  try {
    namespace = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(HEADER_BYTES + 1, fieldsOffset)
    )
  } catch {
    return null
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return {
    ...header,
    kind: 'action',
    chunk: {
      namespace,
      messageId: view.getUint32(fieldsOffset, true),
      index: view.getUint32(fieldsOffset + 4, true),
      count: view.getUint32(fieldsOffset + 8, true),
      totalLength: view.getUint32(fieldsOffset + 12, true),
      data: bytes.subarray(dataOffset)
    }
  }
}
