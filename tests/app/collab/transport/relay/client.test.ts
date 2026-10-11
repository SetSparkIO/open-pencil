import { afterEach, expect, spyOn, test } from 'bun:test'

import {
  RELAY_CLOSE_REFUSED,
  configuredRelay,
  joinRelayCollabRoom,
  resolveRelayURL
} from '@/app/collab/transport/relay/client'
import { decodeFrame, encodeFrame, type RelayFrame } from '@/app/collab/transport/relay/frame'
import type { CollabRoomTransport } from '@/app/collab/transport/types'

import { asDouble } from '#tests/helpers/doubles'

const ROOM = 'client-test-room-01'
const BOB = '0b'.repeat(16)
const CAROL = '0c'.repeat(16)

type Listener = (event: { data?: unknown; code?: number }) => void

/** A WebSocket the test opens, feeds and closes by hand. */
class FakeSocket {
  readyState: number = WebSocket.CONNECTING
  binaryType = 'blob'
  readonly sent: RelayFrame[] = []
  private readonly listeners = new Map<string, Listener[]>()

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  send(bytes: Uint8Array) {
    const frame = decodeFrame(bytes)
    if (frame) this.sent.push(frame)
  }

  close() {
    this.serverClose(1000)
  }

  open() {
    this.readyState = WebSocket.OPEN
    this.emit('open', {})
  }

  receive(frame: RelayFrame) {
    this.emit('message', { data: encodeFrame(frame).buffer })
  }

  serverClose(code: number) {
    if (this.readyState === WebSocket.CLOSED) return
    this.readyState = WebSocket.CLOSED
    this.emit('close', { code })
  }

  private emit(type: string, event: { data?: unknown; code?: number }) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

const transports: CollabRoomTransport[] = []

afterEach(async () => {
  for (const transport of transports.splice(0)) await transport.leave()
})

function join(options: { idleTimeoutMs?: number; pingIntervalMs?: number } = {}) {
  const sockets: FakeSocket[] = []
  const transport = joinRelayCollabRoom(ROOM, {
    url: 'wss://relay.example/collab',
    reconnectBaseMs: 0,
    reconnectMaxMs: 0,
    createSocket: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return asDouble<WebSocket>(socket)
    },
    ...options
  })
  transports.push(transport)
  const joined: string[] = []
  const left: string[] = []
  transport.onPeerJoin((id) => joined.push(id))
  transport.onPeerLeave((id) => left.push(id))
  return { transport, sockets, joined, left }
}

const nextTask = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 0)
  })

test('the relay setting is a trimmed URL or path, dialled as ws or wss', () => {
  expect(configuredRelay(undefined)).toBeNull()
  expect(configuredRelay('  ')).toBeNull()
  expect(configuredRelay(' /collab ')).toBe('/collab')
  expect(resolveRelayURL('/collab', 'https://design.example/file#x')).toBe(
    'wss://design.example/collab'
  )
  expect(resolveRelayURL('/collab', 'http://localhost:1420/')).toBe('ws://localhost:1420/collab')
  expect(resolveRelayURL('wss://relay.example/c#frag')).toBe('wss://relay.example/c')
  expect(() => resolveRelayURL('ftp://relay.example/')).toThrow()
  expect(() => resolveRelayURL('/collab')).toThrow()
})

test('joining says hello, and a hello is answered with a welcome to that peer', () => {
  const { sockets, joined } = join()
  sockets[0].open()
  const [hello] = sockets[0].sent
  expect(hello).toMatchObject({ kind: 'hello', targetId: null, roomId: ROOM })
  const self = hello.senderId

  sockets[0].receive({ kind: 'hello', senderId: BOB, targetId: null, roomId: ROOM })
  expect(joined).toEqual([BOB])
  expect(sockets[0].sent[1]).toEqual({ kind: 'welcome', senderId: self, targetId: BOB })

  // A peer that says hello again has reconnected and is announced again for a fresh sync.
  sockets[0].receive({ kind: 'hello', senderId: BOB, targetId: null, roomId: ROOM })
  expect(joined).toEqual([BOB, BOB])
})

test("frames for another peer and the client's own echoes are ignored", () => {
  const { transport, sockets, joined } = join()
  const received: string[] = []
  transport.makeAction('doc')[1]((_data, from) => received.push(from))
  sockets[0].open()
  const self = sockets[0].sent[0].senderId
  const action = (senderId: string, targetId: string | null): RelayFrame => ({
    kind: 'action',
    senderId,
    targetId,
    chunk: {
      namespace: 'doc',
      messageId: 0,
      index: 0,
      count: 1,
      totalLength: 1,
      data: new Uint8Array([1])
    }
  })

  sockets[0].receive({ kind: 'welcome', senderId: BOB, targetId: CAROL })
  sockets[0].receive(action(BOB, CAROL))
  sockets[0].receive(action(self, null))
  expect(joined).toEqual([])
  expect(received).toEqual([])

  sockets[0].receive(action(BOB, self))
  expect(joined).toEqual([BOB])
  expect(received).toEqual([BOB])
})

test('a namespace can be registered once', () => {
  const { transport } = join()
  transport.makeAction('doc')[1](() => undefined)
  expect(() => transport.makeAction('doc')[1](() => undefined)).toThrow()
})

test('a lost socket drops every peer and redials under the same id', async () => {
  const error = spyOn(console, 'error').mockImplementation(() => undefined)
  try {
    const { sockets, joined, left } = join()
    sockets[0].open()
    const self = sockets[0].sent[0].senderId
    sockets[0].receive({ kind: 'welcome', senderId: BOB, targetId: self })
    expect(joined).toEqual([BOB])

    sockets[0].serverClose(1006)
    expect(left).toEqual([BOB])
    await nextTask()
    expect(sockets).toHaveLength(2)
    sockets[1].serverClose(1006)
    await nextTask()
    expect(error).toHaveBeenCalledTimes(1)

    sockets[2].open()
    expect(sockets[2].sent[0]).toMatchObject({ kind: 'hello', senderId: self })
  } finally {
    error.mockRestore()
  }
})

test('a refused room is not retried', async () => {
  const error = spyOn(console, 'error').mockImplementation(() => undefined)
  try {
    const { sockets } = join()
    sockets[0].open()
    sockets[0].serverClose(RELAY_CLOSE_REFUSED)
    await nextTask()
    expect(sockets).toHaveLength(1)
    expect(error).toHaveBeenCalledTimes(1)
  } finally {
    error.mockRestore()
  }
})

test('leaving says leave and stops redialling', async () => {
  const { transport, sockets } = join()
  sockets[0].open()
  await transport.leave()
  expect(sockets[0].sent.at(-1)?.kind).toBe('leave')
  expect(sockets[0].readyState).toBe(WebSocket.CLOSED)
  await nextTask()
  expect(sockets).toHaveLength(1)
})

test('sends while disconnected are dropped', () => {
  const { transport, sockets } = join()
  transport.makeAction('doc')[0](new Uint8Array([1]))
  sockets[0].open()
  expect(sockets[0].sent.map((frame) => frame.kind)).toEqual(['hello'])
})

test('leaving before the socket opens closes it without a word', async () => {
  const { transport, sockets } = join()
  await transport.leave()
  expect(sockets[0].sent).toEqual([])
  expect(sockets[0].readyState).toBe(WebSocket.CLOSED)
})
