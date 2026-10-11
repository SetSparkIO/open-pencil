#!/usr/bin/env bun
/**
 * Runs the collaboration relay for builds made with `VITE_OPENPENCIL_COLLAB_RELAY`.
 *
 *   COLLAB_RELAY_ORIGINS=https://design.example.com bun tools/dev/collab-relay/src/main.ts
 *
 * COLLAB_RELAY_ORIGINS  comma-separated origins the editor is served from (required; a browser
 *                       on any other origin is refused)
 * COLLAB_RELAY_HOST     address to bind, default 127.0.0.1 (put a TLS proxy in front)
 * COLLAB_RELAY_PORT     port, default 8787; 0 picks a free one
 * COLLAB_RELAY_PATH     WebSocket path, default /collab
 *
 * Prints one line with the address once it is listening.
 */
import { compact } from 'es-toolkit'

import { startRelay } from './relay'

function originsFrom(value: string | undefined): string[] {
  const origins = compact((value ?? '').split(',').map((origin) => origin.trim()))
  for (const origin of origins) {
    if (new URL(origin).origin !== origin) throw new Error(`Not an origin: ${origin}`)
  }
  return origins
}

const allowedOrigins = originsFrom(process.env.COLLAB_RELAY_ORIGINS)
if (allowedOrigins.length === 0) {
  console.error('Set COLLAB_RELAY_ORIGINS to the origin the editor is served from.')
  process.exit(1)
}

const relay = startRelay({
  allowedOrigins,
  hostname: process.env.COLLAB_RELAY_HOST || '127.0.0.1',
  port: Number(process.env.COLLAB_RELAY_PORT || 8787),
  path: process.env.COLLAB_RELAY_PATH || '/collab'
})
console.log(`collab relay listening on ${relay.url.href}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    relay.stop()
    process.exit(0)
  })
}
