import type { ActionChunk } from './frame'

/** Small enough to stay well under the relay's frame limit, large enough to keep frames few. */
export const CHUNK_BYTES = 256 * 1024
/** A document with every image inline; anything larger is refused rather than buffered. */
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024

export function splitMessage(
  namespace: string,
  messageId: number,
  data: Uint8Array,
  chunkBytes = CHUNK_BYTES
): ActionChunk[] {
  if (data.length > MAX_MESSAGE_BYTES) throw new Error('Collaboration message is too large')
  const count = Math.max(1, Math.ceil(data.length / chunkBytes))
  const chunks: ActionChunk[] = []
  for (let index = 0; index < count; index++) {
    chunks.push({
      namespace,
      messageId,
      index,
      count,
      totalLength: data.length,
      data: data.subarray(index * chunkBytes, (index + 1) * chunkBytes)
    })
  }
  return chunks
}

interface PendingMessage {
  namespace: string
  messageId: number
  count: number
  totalLength: number
  next: number
  received: number
  parts: Uint8Array[]
}

/**
 * Puts chunked messages back together, one sender at a time. A sender writes every chunk of a
 * message before the next message and the relay keeps each sender's order, so a sender has at
 * most one message in flight; a chunk out of that order drops the message. Memory follows the
 * bytes actually received, never the length a sender claims.
 */
export class MessageAssembler {
  private readonly pending = new Map<string, PendingMessage>()

  add(senderId: string, chunk: ActionChunk): Uint8Array | null {
    if (chunk.index === 0) {
      this.pending.delete(senderId)
      if (
        chunk.count === 0 ||
        chunk.totalLength > MAX_MESSAGE_BYTES ||
        chunk.count > Math.max(1, chunk.totalLength)
      ) {
        return null
      }
      this.pending.set(senderId, {
        namespace: chunk.namespace,
        messageId: chunk.messageId,
        count: chunk.count,
        totalLength: chunk.totalLength,
        next: 0,
        received: 0,
        parts: []
      })
    }

    const message = this.pending.get(senderId)
    if (
      !message ||
      message.messageId !== chunk.messageId ||
      message.namespace !== chunk.namespace ||
      message.count !== chunk.count ||
      message.totalLength !== chunk.totalLength ||
      message.next !== chunk.index ||
      message.received + chunk.data.length > message.totalLength
    ) {
      this.pending.delete(senderId)
      return null
    }

    message.parts.push(chunk.data.slice())
    message.received += chunk.data.length
    message.next++
    if (message.next < message.count) return null

    this.pending.delete(senderId)
    if (message.received !== message.totalLength) return null
    if (message.parts.length === 1) return message.parts[0]
    const data = new Uint8Array(message.totalLength)
    let offset = 0
    for (const part of message.parts) {
      data.set(part, offset)
      offset += part.length
    }
    return data
  }

  forget(senderId: string) {
    this.pending.delete(senderId)
  }

  clear() {
    this.pending.clear()
  }
}
