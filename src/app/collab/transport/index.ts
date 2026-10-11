import { appRuntimeConfig } from '@/app/runtime/config'
import { IS_BROWSER } from '@/constants'

import { configuredRelay, joinRelayCollabRoom, resolveRelayURL } from './relay/client'
import { joinTestCollabRoom } from './test'
import { joinTrysteroCollabRoom } from './trystero'
import type { JoinCollabRoom } from './types'

function usesTestTransport(): boolean {
  return import.meta.env.DEV && appRuntimeConfig.collaborationTransport === 'test'
}

/**
 * A build with `VITE_OPENPENCIL_COLLAB_RELAY` (a `wss:` URL, or a path on the editor's own
 * origin such as `/collab`) collaborates through that relay instead of the public signaling
 * brokers. In development `?collabTransport=relay&collabRelay=<url>` does the same for one page.
 */
function relaySetting(): string | null {
  if (import.meta.env.DEV && appRuntimeConfig.collaborationTransport === 'relay') {
    const url = appRuntimeConfig.collaborationRelayURL
    if (!url) throw new Error('Relay collaboration transport requires collabRelay')
    return url
  }
  return configuredRelay(import.meta.env.VITE_OPENPENCIL_COLLAB_RELAY)
}

export const joinCollabRoom: JoinCollabRoom = (roomId) => {
  if (usesTestTransport()) return joinTestCollabRoom(roomId)
  const relay = relaySetting()
  if (!relay) return joinTrysteroCollabRoom(roomId)
  const url = resolveRelayURL(relay, IS_BROWSER ? window.location.href : undefined)
  return joinRelayCollabRoom(roomId, { url })
}

export type { CollabRoomTransport, JoinCollabRoom } from './types'
