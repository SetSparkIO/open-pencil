import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { expect, test, type Browser } from '@playwright/test'

import { CanvasHelper } from '#tests/helpers/canvas'
import { collaborationErrors, connect, type Peer } from '#tests/helpers/collab/room'

const APP_ORIGIN = `http://localhost:${process.env.OPENPENCIL_TEST_PORT ?? '1420'}`
const LOST = 'Collaboration relay connection lost; reconnecting'
const RELAY_MAIN = fileURLToPath(
  new URL('../../../tools/dev/collab-relay/src/main.ts', import.meta.url)
)

type RelayProcess = { url: string; port: string; stop: () => Promise<void> }

/** Runs the relay tool as its own process, as a deployment would, and reads its address. */
async function startRelayProcess(port = '0'): Promise<RelayProcess> {
  const child: ChildProcess = spawn('bun', [RELAY_MAIN], {
    cwd: process.cwd(),
    env: { ...process.env, COLLAB_RELAY_ORIGINS: APP_ORIGIN, COLLAB_RELAY_PORT: port },
    stdio: ['ignore', 'pipe', 'inherit']
  })
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
  })
  const stop = async () => {
    if (child.exitCode === null) child.kill('SIGTERM')
    await exited
  }
  try {
    const url = await new Promise<string>((resolve, reject) => {
      if (!child.stdout) {
        reject(new Error('Relay stdout unavailable'))
        return
      }
      const lines = createInterface({ input: child.stdout })
      lines.on('line', (line) => {
        const match = /^collab relay listening on (\S+)$/.exec(line)
        if (match) resolve(match[1])
      })
      child.once('exit', (code) => reject(new Error(`Relay exited with ${code}`)))
    })
    return { url, port: new URL(url).port, stop }
  } catch (error) {
    await stop()
    throw error
  }
}

async function createRelayPeer(browser: Browser, name: string, relayURL: string): Promise<Peer> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  try {
    const page = await context.newPage()
    await page.goto(`/?test&collabTransport=relay&collabRelay=${encodeURIComponent(relayURL)}`)
    await page.evaluate(
      (localName) => window.openPencil?.test?.collab?.setLocalName(localName),
      name
    )
    const canvas = new CanvasHelper(page)
    await canvas.waitForInit()
    canvas.errors.length = 0
    return { context, page, canvas }
  } catch (error) {
    await context.close()
    throw error
  }
}

function peerCount(peer: Peer) {
  return peer.page.evaluate(() => window.openPencil?.test?.collab?.peerCount())
}

function nodeName(peer: Peer, id: string) {
  return peer.page.evaluate(
    (nodeId) => window.openPencil?.getStore?.().graph.getNode(nodeId)?.name,
    id
  )
}

test('peers collaborate through the relay, carry a large document, and survive a restart', async ({
  browser
}) => {
  test.setTimeout(120_000)
  let relay = await startRelayProcess()
  const peers: Peer[] = []
  try {
    const host = await createRelayPeer(browser, 'Host', relay.url)
    peers.push(host)
    await connect(host)
    // A name of 3 MB makes the joining peer's first sync many relay frames long.
    const nodeId = await host.page.evaluate(() => {
      const store = window.openPencil?.getStore?.()
      if (!store) throw new Error('OpenPencil store not initialized')
      const node = store.graph.createNode('RECTANGLE', store.state.currentPageId, {
        name: 'L'.repeat(3 * 1024 * 1024),
        x: 160,
        y: 140,
        width: 120,
        height: 80
      })
      store.requestRender()
      return node.id
    })

    const guest = await createRelayPeer(browser, 'Guest', relay.url)
    peers.push(guest)
    await connect(guest)
    await expect.poll(() => peerCount(host)).toBe(1)
    await expect.poll(() => peerCount(guest)).toBe(1)
    await expect.poll(async () => (await nodeName(guest, nodeId))?.length).toBe(3 * 1024 * 1024)

    await guest.page.evaluate((id) => {
      window.openPencil?.getStore?.().updateNode(id, { name: 'Edited by Guest' })
    }, nodeId)
    await expect.poll(() => nodeName(host, nodeId)).toBe('Edited by Guest')

    await relay.stop()
    await expect.poll(() => peerCount(host)).toBe(0)
    await expect.poll(() => peerCount(guest)).toBe(0)
    // Edits made while the relay is down reach the other side through the resync.
    await host.page.evaluate((id) => {
      window.openPencil?.getStore?.().updateNode(id, { name: 'Edited while the relay was down' })
    }, nodeId)
    relay = await startRelayProcess(relay.port)

    await expect.poll(() => peerCount(host), { timeout: 60_000 }).toBe(1)
    await expect.poll(() => peerCount(guest), { timeout: 60_000 }).toBe(1)
    await expect.poll(() => nodeName(guest, nodeId)).toBe('Edited while the relay was down')

    // One relay report per outage and peer. Other console errors (fonts, a browser's own
    // failed redials) depend on the machine and are not the relay client's to make.
    for (const peer of peers) {
      const relayErrors = collaborationErrors(peer).filter((error) =>
        error.includes('Collaboration relay')
      )
      expect(relayErrors).toEqual([LOST])
    }
  } finally {
    for (const peer of peers) await peer.context.close()
    await relay.stop()
  }
})
