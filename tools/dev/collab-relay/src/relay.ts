import type { Server, ServerWebSocket } from 'bun'

import { MAX_MESSAGE_BYTES } from '@/app/collab/transport/relay/chunks'
import {
  HEADER_BYTES,
  decodeFrame,
  decodeHeader,
  encodeFrame
} from '@/app/collab/transport/relay/frame'

/** Matches `RELAY_CLOSE_REFUSED` in the client: a protocol violation, do not retry. */
const CLOSE_REFUSED = 4400
/** The relay is full; the client retries with backoff. */
const CLOSE_FULL = 4429
/** The socket fell too far behind; the client reconnects and resyncs. */
const CLOSE_SLOW = 4408

export interface RelayOptions {
  hostname?: string
  /** 0 picks a free port. */
  port?: number
  /** WebSocket path; every other path but `/healthz` is 404. */
  path?: string
  /**
   * Origins a browser may open the relay from. A request with any other `Origin` header is
   * refused, so a page on another site cannot ride a visitor's cookies into a room.
   * Requests without an `Origin` header come from non-browser clients and are allowed.
   */
  allowedOrigins: readonly string[]
  maxRooms?: number
  maxPeersPerRoom?: number
  /** Largest single frame; clients send chunks of 256 KiB. */
  maxFrameBytes?: number
  /** Bytes queued for one slow socket before it is closed rather than fed a gapped stream. */
  maxQueuedBytes?: number
  /** A socket that has not said hello by then is closed. */
  helloTimeoutMs?: number
  /** Seconds without traffic before a socket is closed; Bun pings idle sockets before that. */
  idleTimeoutSeconds?: number
}

export interface Relay {
  readonly url: URL
  /** Number of open rooms, for tests and health. */
  readonly roomCount: () => number
  /** Closes every socket and frees the port at once. */
  stop(): void
}

interface Peer {
  peerId: string | null
  roomId: string | null
  helloTimer: ReturnType<typeof setTimeout> | null
  saidLeave: boolean
}

type PeerSocket = ServerWebSocket<Peer>

/**
 * Forwards binary collaboration frames between the sockets in a room. Rooms exist only while
 * someone is in them; nothing is written to disk, and nothing about a room or its content is
 * logged. The relay reads frame headers to route and never reads an action's payload.
 */
export function startRelay(options: RelayOptions): Relay {
  const {
    hostname = '127.0.0.1',
    port = 0,
    path = '/collab',
    allowedOrigins,
    maxRooms = 1_000,
    maxPeersPerRoom = 32,
    maxFrameBytes = 1024 * 1024,
    maxQueuedBytes = MAX_MESSAGE_BYTES + 8 * 1024 * 1024,
    helloTimeoutMs = 10_000,
    idleTimeoutSeconds = 60
  } = options
  const origins = new Set(allowedOrigins)
  const rooms = new Map<string, Map<string, PeerSocket>>()

  function deliver(socket: PeerSocket, bytes: Uint8Array) {
    // 0 means Bun dropped the frame; a gap would corrupt the peer's reassembly.
    if (socket.send(bytes) === 0) socket.close(CLOSE_SLOW, 'too slow')
  }

  function broadcast(roomId: string, senderId: string, bytes: Uint8Array) {
    for (const [peerId, socket] of rooms.get(roomId) ?? []) {
      if (peerId !== senderId) deliver(socket, bytes)
    }
  }

  function refuse(socket: PeerSocket) {
    socket.close(CLOSE_REFUSED, 'refused')
  }

  function join(socket: PeerSocket, bytes: Uint8Array) {
    const frame = decodeFrame(bytes)
    if (frame?.kind !== 'hello' || frame.targetId !== null) return refuse(socket)
    let room = rooms.get(frame.roomId)
    if (!room) {
      if (rooms.size >= maxRooms) return socket.close(CLOSE_FULL, 'full')
      room = new Map()
      rooms.set(frame.roomId, room)
    }
    const previous = room.get(frame.senderId)
    if (!previous && room.size >= maxPeersPerRoom) return socket.close(CLOSE_FULL, 'full')
    if (socket.data.helloTimer !== null) clearTimeout(socket.data.helloTimer)
    socket.data.helloTimer = null
    socket.data.peerId = frame.senderId
    socket.data.roomId = frame.roomId
    room.set(frame.senderId, socket)
    // The same peer redialling: its old socket is dead, and the others hear hello, not leave.
    if (previous) {
      previous.data.roomId = null
      previous.terminate()
    }
    broadcast(frame.roomId, frame.senderId, bytes)
  }

  function forward(socket: PeerSocket, bytes: Uint8Array) {
    const { peerId, roomId } = socket.data
    if (peerId === null || roomId === null) return
    const header = decodeHeader(bytes)
    if (!header || header.senderId !== peerId || header.kind === 'hello') return refuse(socket)
    switch (header.kind) {
      case 'ping':
        if (bytes.length !== HEADER_BYTES) return refuse(socket)
        return deliver(socket, encodeFrame({ kind: 'pong', senderId: peerId, targetId: null }))
      case 'pong':
        return
      case 'leave':
        socket.data.saidLeave = true
        return broadcast(roomId, peerId, bytes)
      default: {
        if (header.targetId === null) return broadcast(roomId, peerId, bytes)
        const target = rooms.get(roomId)?.get(header.targetId)
        if (target) deliver(target, bytes)
      }
    }
  }

  function depart(socket: PeerSocket) {
    if (socket.data.helloTimer !== null) clearTimeout(socket.data.helloTimer)
    const { peerId, roomId } = socket.data
    if (peerId === null || roomId === null) return
    const room = rooms.get(roomId)
    if (room?.get(peerId) !== socket) return
    room.delete(peerId)
    if (room.size === 0) rooms.delete(roomId)
    else if (!socket.data.saidLeave) {
      broadcast(roomId, peerId, encodeFrame({ kind: 'leave', senderId: peerId, targetId: null }))
    }
  }

  const server: Server<Peer> = Bun.serve({
    hostname,
    port,
    fetch(request, httpServer) {
      const { pathname } = new URL(request.url)
      if (pathname === '/healthz') return new Response('ok\n')
      if (pathname !== path) return new Response('Not found\n', { status: 404 })
      const origin = request.headers.get('origin')
      if (origin !== null && !origins.has(origin)) {
        return new Response('Forbidden\n', { status: 403 })
      }
      const peer: Peer = { peerId: null, roomId: null, helloTimer: null, saidLeave: false }
      if (httpServer.upgrade(request, { data: peer })) return undefined
      return new Response('Expected a WebSocket upgrade\n', { status: 426 })
    },
    websocket: {
      data: {} as Peer,
      maxPayloadLength: maxFrameBytes,
      backpressureLimit: maxQueuedBytes,
      closeOnBackpressureLimit: true,
      idleTimeout: idleTimeoutSeconds,
      sendPings: true,
      perMessageDeflate: false,
      open(socket) {
        socket.data.helloTimer = setTimeout(() => refuse(socket), helloTimeoutMs)
      },
      message(socket, message) {
        if (typeof message === 'string') return refuse(socket)
        const bytes = new Uint8Array(message.buffer, message.byteOffset, message.byteLength)
        if (socket.data.peerId === null) join(socket, bytes)
        else forward(socket, bytes)
      },
      close(socket) {
        depart(socket)
      }
    }
  })

  return {
    url: new URL(`ws://${server.hostname}:${server.port}${path}`),
    roomCount: () => rooms.size,
    stop() {
      // Not awaited: Bun's promise never settles once the relay itself has closed a socket,
      // although the sockets and the port are released straight away.
      void server.stop(true)
    }
  }
}
