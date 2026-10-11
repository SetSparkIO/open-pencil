import { useIntervalFn } from '@vueuse/core'

import { randomHex, randomIndex } from '@open-pencil/scene-graph/random'

import type { CollabAction, CollabActionReceiver, CollabRoomTransport } from '../types'
import { MessageAssembler, splitMessage } from './chunks'
import { PEER_ID_BYTES, decodeFrame, encodeFrame, isRelayRoomId, type RelayFrame } from './frame'

/** The relay closes with this code when the hello is malformed; retrying cannot help. */
export const RELAY_CLOSE_REFUSED = 4400

export interface RelayClientOptions {
  /** `ws:` or `wss:` URL of the relay. */
  url: string
  /** Proxies such as Cloudflare drop a socket idle for about 100 s, so ping well inside that. */
  pingIntervalMs?: number
  /** With nothing received for this long the socket is treated as lost. */
  idleTimeoutMs?: number
  reconnectBaseMs?: number
  reconnectMaxMs?: number
  createSocket?: (url: string) => WebSocket
}

/** The build's `VITE_OPENPENCIL_COLLAB_RELAY`, or null when the build keeps trystero. */
export function configuredRelay(setting: string | undefined): string | null {
  return setting?.trim() || null
}

/**
 * Accepts an absolute `ws:`/`wss:`/`http:`/`https:` URL or a path on the page's own origin
 * (`/collab`), and returns the WebSocket URL to dial.
 */
export function resolveRelayURL(configured: string, pageURL?: string): string {
  const url = new URL(configured, pageURL)
  if (url.protocol === 'http:') url.protocol = 'ws:'
  else if (url.protocol === 'https:') url.protocol = 'wss:'
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('Collaboration relay URL must be ws:, wss:, http: or https:')
  }
  url.hash = ''
  return url.href
}

function frameBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  return null
}

/**
 * Joins a room through the collaboration relay. Peers are the other sockets in the room; the
 * relay forwards frames and keeps nothing. When the socket drops, every peer is reported as
 * gone and the client redials with backoff under the same peer id; on return the peers greet
 * each other again and the room's sync handshake brings both sides up to date. Actions sent
 * while disconnected are dropped for the same reason.
 */
export function joinRelayCollabRoom(
  roomId: string,
  options: RelayClientOptions
): CollabRoomTransport {
  if (typeof WebSocket === 'undefined') {
    throw new TypeError('Relay collaboration transport requires WebSocket')
  }
  if (!isRelayRoomId(roomId)) throw new Error('Invalid collaboration room id')

  const {
    url,
    pingIntervalMs = 25_000,
    idleTimeoutMs = 60_000,
    reconnectBaseMs = 1_000,
    reconnectMaxMs = 30_000,
    createSocket = (target) => new WebSocket(target)
  } = options
  const selfId = randomHex(PEER_ID_BYTES)
  const peers = new Set<string>()
  const receivers = new Map<string, CollabActionReceiver>()
  const assembler = new MessageAssembler()
  let joinHandler: ((peerId: string) => void) | null = null
  let leaveHandler: ((peerId: string) => void) | null = null
  let socket: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let attempt = 0
  let lastFrameAt = 0
  let outageReported = false
  let nextMessageId = 0
  let left = false

  function send(frame: RelayFrame): boolean {
    if (socket?.readyState !== WebSocket.OPEN) return false
    socket.send(encodeFrame(frame))
    return true
  }

  function addPeer(id: string) {
    if (peers.has(id)) return
    peers.add(id)
    joinHandler?.(id)
  }

  function removePeer(id: string) {
    assembler.forget(id)
    if (peers.delete(id)) leaveHandler?.(id)
  }

  const ping = useIntervalFn(
    () => {
      if (!socket) return
      if (Date.now() - lastFrameAt > idleTimeoutMs) lose(socket)
      else send({ kind: 'ping', senderId: selfId, targetId: null })
    },
    pingIntervalMs,
    { immediate: false }
  )

  function scheduleReconnect() {
    const ceiling = Math.min(reconnectMaxMs, reconnectBaseMs * 2 ** attempt)
    const half = Math.floor(ceiling / 2)
    attempt++
    reconnectTimer = setTimeout(
      () => {
        reconnectTimer = null
        if (!left) connect()
      },
      half + randomIndex(half + 1)
    )
  }

  /** Forgets the socket at once; a dead socket can take minutes to report its own close. */
  function lose(ws: WebSocket, code?: number) {
    if (socket !== ws) return
    socket = null
    ping.pause()
    for (const id of peers) removePeer(id)
    assembler.clear()
    if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close()
    if (left) return
    if (code === RELAY_CLOSE_REFUSED) {
      console.error('Collaboration relay refused the room')
      return
    }
    if (!outageReported) {
      outageReported = true
      console.error('Collaboration relay connection lost; reconnecting')
    }
    scheduleReconnect()
  }

  function receive(frame: RelayFrame) {
    if (frame.kind === 'ping' || frame.kind === 'pong') return
    if (frame.senderId === selfId) return
    if (frame.targetId !== null && frame.targetId !== selfId) return
    switch (frame.kind) {
      case 'hello':
        // A known peer saying hello again has reconnected and needs a fresh sync.
        peers.add(frame.senderId)
        joinHandler?.(frame.senderId)
        send({ kind: 'welcome', senderId: selfId, targetId: frame.senderId })
        return
      case 'welcome':
        addPeer(frame.senderId)
        return
      case 'leave':
        removePeer(frame.senderId)
        return
      case 'action': {
        addPeer(frame.senderId)
        const data = assembler.add(frame.senderId, frame.chunk)
        if (data) receivers.get(frame.chunk.namespace)?.(data, frame.senderId)
      }
    }
  }

  function connect() {
    const ws = createSocket(url)
    ws.binaryType = 'arraybuffer'
    socket = ws
    ws.addEventListener('open', () => {
      if (socket !== ws) return
      attempt = 0
      outageReported = false
      lastFrameAt = Date.now()
      send({ kind: 'hello', senderId: selfId, targetId: null, roomId })
      ping.resume()
    })
    ws.addEventListener('message', (event: MessageEvent) => {
      if (socket !== ws) return
      lastFrameAt = Date.now()
      const bytes = frameBytes(event.data)
      const frame = bytes && decodeFrame(bytes)
      if (frame) receive(frame)
    })
    ws.addEventListener('close', (event: CloseEvent) => lose(ws, event.code))
  }

  connect()

  function sendAction(namespace: string, data: Uint8Array, targetId?: string) {
    if (socket?.readyState !== WebSocket.OPEN) return
    const messageId = nextMessageId
    nextMessageId = (nextMessageId + 1) >>> 0
    for (const chunk of splitMessage(namespace, messageId, data)) {
      send({ kind: 'action', senderId: selfId, targetId: targetId ?? null, chunk })
    }
  }

  function receiveAction(namespace: string, handler: CollabActionReceiver) {
    if (receivers.has(namespace)) {
      throw new Error(`Collaboration action ${namespace} is already registered`)
    }
    receivers.set(namespace, handler)
  }

  return {
    makeAction(namespace): CollabAction {
      return [
        (data, targetId) => sendAction(namespace, data, targetId),
        (handler) => receiveAction(namespace, handler)
      ]
    },
    async leave() {
      if (left) return
      left = true
      if (reconnectTimer !== null) clearTimeout(reconnectTimer)
      ping.pause()
      peers.clear()
      receivers.clear()
      assembler.clear()
      const ws = socket
      socket = null
      if (!ws) return
      // A socket still connecting has not said hello, so no peer is waiting for a leave.
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(encodeFrame({ kind: 'leave', senderId: selfId, targetId: null }))
      }
      ws.close()
    },
    onPeerJoin(handler) {
      joinHandler = handler
      for (const id of peers) queueMicrotask(() => handler(id))
    },
    onPeerLeave(handler) {
      leaveHandler = handler
    }
  }
}
