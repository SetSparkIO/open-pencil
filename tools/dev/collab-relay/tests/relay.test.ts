import { afterEach, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { request } from 'node:http'

import { fromUint8Array } from 'js-base64'

import { joinRelayCollabRoom, type RelayClientOptions } from '@/app/collab/transport/relay/client'
import { decodeFrame, encodeFrame, type RelayFrame } from '@/app/collab/transport/relay/frame'
import type { CollabRoomTransport } from '@/app/collab/transport/types'

import { startRelay, type Relay } from '../src/relay'

const ROOM = 'relay-test-room-0001'
const ORIGIN = 'https://editor.example'
const ALICE = '0a'.repeat(16)
const BOB = '0b'.repeat(16)
const CAROL = '0c'.repeat(16)

const cleanup: (() => unknown)[] = []

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

function relay(options: Partial<Parameters<typeof startRelay>[0]> = {}): Relay {
  const started = startRelay({ allowedOrigins: [ORIGIN], ...options })
  cleanup.push(() => started.stop())
  return started
}

async function until(condition: () => boolean, what: string) {
  const deadline = Date.now() + 5_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await Bun.sleep(5)
  }
}

interface RawPeer {
  socket: WebSocket
  frames: RelayFrame[]
  closed: Promise<number>
  send(frame: RelayFrame | Uint8Array<ArrayBuffer> | string): void
}

/** The status a WebSocket handshake from `origin` gets: 101 when the relay takes it. */
function upgradeStatus(url: URL, origin: string) {
  return new Promise<number>((resolve, reject) => {
    const req = request({
      host: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        origin,
        'sec-websocket-key': fromUint8Array(randomBytes(16)),
        'sec-websocket-version': '13'
      }
    })
    req.on('upgrade', (response, socket) => {
      socket.destroy()
      resolve(response.statusCode ?? 0)
    })
    req.on('response', (response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
}

async function rawPeer(url: URL): Promise<RawPeer> {
  const socket = new WebSocket(url)
  socket.binaryType = 'arraybuffer'
  const frames: RelayFrame[] = []
  socket.addEventListener('message', (event) => {
    const frame = decodeFrame(new Uint8Array(event.data as ArrayBuffer))
    if (frame) frames.push(frame)
  })
  const closed = new Promise<number>((resolve) => {
    socket.addEventListener('close', (event) => resolve(event.code))
  })
  cleanup.push(() => socket.close())
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error('socket failed')), { once: true })
  })
  return {
    socket,
    frames,
    closed,
    send(frame) {
      socket.send(
        typeof frame === 'string' || frame instanceof Uint8Array ? frame : encodeFrame(frame)
      )
    }
  }
}

function hello(senderId: string, roomId = ROOM): RelayFrame {
  return { kind: 'hello', senderId, targetId: null, roomId }
}

function action(senderId: string, targetId: string | null, data: number[]): RelayFrame {
  return {
    kind: 'action',
    senderId,
    targetId,
    chunk: {
      namespace: 'test',
      messageId: 0,
      index: 0,
      count: 1,
      totalLength: data.length,
      data: new Uint8Array(data)
    }
  }
}

test('serves health and refuses other paths and foreign origins', async () => {
  const { url } = relay()
  const http = new URL(url)
  http.protocol = 'http:'

  expect((await fetch(new URL('/healthz', http))).status).toBe(200)
  expect((await fetch(new URL('/other', http))).status).toBe(404)
  expect(await upgradeStatus(url, 'https://attacker.example')).toBe(403)
  expect(await upgradeStatus(url, ORIGIN)).toBe(101)
})

test('routes broadcasts to the room and targeted frames to one peer', async () => {
  const { url } = relay()
  const alice = await rawPeer(url)
  const bob = await rawPeer(url)
  const carol = await rawPeer(url)
  const elsewhere = await rawPeer(url)
  alice.send(hello(ALICE))
  bob.send(hello(BOB))
  carol.send(hello(CAROL))
  elsewhere.send(hello('0d'.repeat(16), 'another-room-000001'))
  await until(() => alice.frames.length === 2, 'hellos')

  alice.send(action(ALICE, null, [1]))
  alice.send(action(ALICE, BOB, [2]))
  await until(() => carol.frames.some((frame) => frame.kind === 'action'), 'broadcast')
  await until(() => bob.frames.filter((frame) => frame.kind === 'action').length === 2, 'target')

  const payloads = (frames: RelayFrame[]) =>
    frames.flatMap((frame) => (frame.kind === 'action' ? [[...frame.chunk.data]] : []))
  expect(payloads(bob.frames)).toEqual([[1], [2]])
  expect(payloads(carol.frames)).toEqual([[1]])
  expect(alice.frames.filter((frame) => frame.kind === 'action')).toEqual([])
  expect(elsewhere.frames).toEqual([])
})

test('closes sockets that break the protocol', async () => {
  const { url } = relay()

  const textFirst = await rawPeer(url)
  textFirst.send('{"type":"hello"}')
  expect(await textFirst.closed).toBe(4400)

  const badRoom = await rawPeer(url)
  const badHello = encodeFrame(hello(ALICE))
  badHello[badHello.length - 1] = '!'.charCodeAt(0)
  badRoom.send(badHello)
  expect(await badRoom.closed).toBe(4400)

  const spoofer = await rawPeer(url)
  spoofer.send(hello(ALICE))
  spoofer.send(action(BOB, null, [1]))
  expect(await spoofer.closed).toBe(4400)

  const twice = await rawPeer(url)
  twice.send(hello(BOB))
  twice.send(hello(BOB))
  expect(await twice.closed).toBe(4400)
})

test('closes a socket that never says hello', async () => {
  const { url } = relay({ helloTimeoutMs: 50 })
  const silent = await rawPeer(url)
  expect(await silent.closed).toBe(4400)
})

test('answers pings and announces a peer that drops without saying leave', async () => {
  const { url, roomCount } = relay()
  const alice = await rawPeer(url)
  const bob = await rawPeer(url)
  alice.send(hello(ALICE))
  bob.send(hello(BOB))
  await until(() => alice.frames.length === 1, 'hello')

  alice.send({ kind: 'ping', senderId: ALICE, targetId: null })
  await until(() => alice.frames.some((frame) => frame.kind === 'pong'), 'pong')

  bob.socket.close()
  await until(() => alice.frames.some((frame) => frame.kind === 'leave'), 'leave')
  expect(alice.frames.find((frame) => frame.kind === 'leave')?.senderId).toBe(BOB)

  alice.socket.close()
  await until(() => roomCount() === 0, 'empty room to go')
})

test('a peer redialling with its id replaces its old socket without a leave', async () => {
  const { url } = relay()
  const alice = await rawPeer(url)
  const bobOld = await rawPeer(url)
  alice.send(hello(ALICE))
  bobOld.send(hello(BOB))
  await until(() => alice.frames.length === 1, 'first hello')

  const bobNew = await rawPeer(url)
  bobNew.send(hello(BOB))
  await bobOld.closed
  await until(() => alice.frames.length === 2, 'second hello')
  alice.send(action(ALICE, BOB, [7]))
  await until(() => bobNew.frames.some((frame) => frame.kind === 'action'), 'action')
  expect(alice.frames.map((frame) => frame.kind)).toEqual(['hello', 'hello'])
})

test('refuses peers past the room limit', async () => {
  const { url } = relay({ maxPeersPerRoom: 1 })
  const alice = await rawPeer(url)
  alice.send(hello(ALICE))
  const bob = await rawPeer(url)
  bob.send(hello(BOB))
  expect(await bob.closed).toBe(4429)
})

interface Client {
  transport: CollabRoomTransport
  peers: Set<string>
  received: { namespace: string; data: Uint8Array; from: string }[]
  send(namespace: string, data: Uint8Array, target?: string): void
}

function client(url: URL, options: Partial<RelayClientOptions> = {}) {
  const transport = joinRelayCollabRoom(ROOM, {
    url: url.href,
    reconnectBaseMs: 20,
    reconnectMaxMs: 40,
    ...options
  })
  cleanup.push(() => transport.leave())
  const result: Client = {
    transport,
    peers: new Set(),
    received: [],
    send(namespace, data, target) {
      senders.get(namespace)?.(data, target)
    }
  }
  const senders = new Map<string, (data: Uint8Array, target?: string) => void>()
  for (const namespace of ['doc', 'awareness']) {
    const [send, receive] = transport.makeAction(namespace)
    senders.set(namespace, send)
    receive((data, from) => result.received.push({ namespace, data, from }))
  }
  transport.onPeerJoin((id) => result.peers.add(id))
  transport.onPeerLeave((id) => result.peers.delete(id))
  return result
}

test('clients find each other and carry a message larger than one frame', async () => {
  const { url } = relay()
  const alice = client(url)
  const bob = client(url)
  await until(() => alice.peers.size === 1 && bob.peers.size === 1, 'peers')

  const large = new Uint8Array(3 * 1024 * 1024 + 17)
  for (let i = 0; i < large.length; i++) large[i] = i % 251
  alice.send('doc', large)
  alice.send('awareness', new Uint8Array([9]), [...alice.peers][0])
  await until(() => bob.received.length === 2, 'messages')

  expect(bob.received[0].namespace).toBe('doc')
  expect(bob.received[0].data).toEqual(large)
  expect(bob.received[1]).toEqual({
    namespace: 'awareness',
    data: new Uint8Array([9]),
    from: [...bob.peers][0]
  })
})

test('clients reconnect after the relay restarts and greet each other again', async () => {
  const first = startRelay({ allowedOrigins: [ORIGIN], port: 0 })
  const { port } = first.url
  const alice = client(first.url)
  const bob = client(first.url)
  await until(() => alice.peers.size === 1 && bob.peers.size === 1, 'peers')
  const errors: unknown[] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => errors.push(args)
  cleanup.push(() => {
    console.error = originalError
  })

  first.stop()
  await until(() => alice.peers.size === 0 && bob.peers.size === 0, 'peers to drop')
  relay({ port: Number(port) })
  await until(() => alice.peers.size === 1 && bob.peers.size === 1, 'peers to return')

  alice.send('doc', new Uint8Array([1, 2, 3]))
  await until(() => bob.received.length === 1, 'message after reconnect')
  expect(errors.length).toBe(2)
})

test('pings keep a quiet room open past the idle timeout', async () => {
  const { url } = relay()
  const alice = client(url, { pingIntervalMs: 20, idleTimeoutMs: 60 })
  const bob = client(url)
  await until(() => alice.peers.size === 1, 'peer')
  const errors: unknown[] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => errors.push(args)
  cleanup.push(() => {
    console.error = originalError
  })

  // The relay answers each ping, so no action traffic for several idle timeouts is fine.
  await Bun.sleep(200)
  expect(alice.peers.size).toBe(1)
  expect(bob.peers.size).toBe(1)
  expect(errors).toEqual([])
})

test('a client turned away by a full room backs off, reports once, and later gets in alone', async () => {
  const { url, stop } = relay({ maxPeersPerRoom: 1 })
  const alice = await rawPeer(url)
  alice.send(hello(ALICE))
  alice.send({ kind: 'ping', senderId: ALICE, targetId: null })
  await until(() => alice.frames.some((frame) => frame.kind === 'pong'), 'alice to join')
  const errors: unknown[] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => errors.push(args)
  cleanup.push(() => {
    console.error = originalError
  })

  let refusals = 0
  let framesReceived = 0
  client(url, {
    reconnectBaseMs: 20,
    reconnectMaxMs: 1_000,
    createSocket(target) {
      const socket = new WebSocket(target)
      socket.addEventListener('close', (event) => {
        if (event.code === 4429) refusals++
      })
      socket.addEventListener('message', () => framesReceived++)
      return socket
    }
  })
  // Doubling from 20 ms leaves room for about six tries in 400 ms, against dozens without it.
  await Bun.sleep(400)
  expect(refusals).toBeGreaterThanOrEqual(2)
  expect(refusals).toBeLessThanOrEqual(7)
  expect(framesReceived).toBe(0)
  expect(errors.length).toBe(1)

  // Bob is alone once Alice goes, so the pong to his first ping is what he receives.
  alice.socket.close()
  await until(() => framesReceived > 0, 'bob to join the empty room')
  stop()
  await until(() => errors.length === 2, 'a fresh report for the next outage')
})
