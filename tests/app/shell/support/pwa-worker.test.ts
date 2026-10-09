import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext, runInContext } from 'node:vm'

import { openPencilPwaPlugin } from '#vite-config/pwa'
import { resolveConfig, type Plugin } from 'vite'
import type { VitePluginPWAAPI } from 'vite-plugin-pwa'

const ORIGIN = 'https://editor.example'
const settled = async () => undefined
const ignore = () => undefined

type FetchListener = (event: {
  request: Request
  respondWith: (response: Promise<Response>) => void
  waitUntil: (promise: Promise<unknown>) => void
}) => void

/** Builds the worker the plugin generates into `outDir`, next to a minimal app shell. */
async function buildWorker(outDir: string): Promise<void> {
  await writeFile(join(outDir, 'index.html'), '<!doctype html><title>shell</title>')
  // The plugin picks the Workbox build from NODE_ENV, which `vite build` sets to production.
  // Babel, which bundles the worker, replaces Error.prepareStackTrace for the whole process
  // and so changes every later stack in the run; both are put back afterwards.
  const nodeEnv = process.env.NODE_ENV
  const prepareStackTrace = Error.prepareStackTrace
  process.env.NODE_ENV = 'production'
  try {
    await generate(outDir)
  } finally {
    if (nodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = nodeEnv
    Error.prepareStackTrace = prepareStackTrace
  }
}

async function generate(outDir: string): Promise<void> {
  const config = await resolveConfig(
    {
      configFile: false,
      root: outDir,
      logLevel: 'silent',
      plugins: [openPencilPwaPlugin()],
      build: { outDir }
    },
    'build',
    'production',
    'production'
  )
  const main = config.plugins.find((plugin) => plugin.name === 'vite-plugin-pwa') as
    | (Plugin & { api: VitePluginPWAAPI })
    | undefined
  if (!main) throw new Error('vite-plugin-pwa is not among the resolved plugins')
  await main.api.generateSW()
}

/**
 * Runs the generated `sw.js` (and the Workbox runtime it imports) in a sandbox standing in for
 * a service worker global, and returns its fetch listeners once its modules have loaded.
 */
async function loadWorker(outDir: string): Promise<FetchListener[]> {
  const listeners: FetchListener[] = []
  const self: Record<string, unknown> = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener(type: string, listener: FetchListener) {
      if (type === 'fetch') listeners.push(listener)
    },
    registration: { scope: `${ORIGIN}/` },
    skipWaiting: settled,
    clients: { claim: settled },
    caches: { open: async () => ({ match: async () => undefined }), match: async () => undefined },
    URL,
    Request,
    Response,
    Headers,
    console
  }
  const sandbox = createContext(self)
  self.self = sandbox
  self.importScripts = (...urls: string[]) => {
    for (const url of urls) {
      const file = join(outDir, new URL(url).pathname)
      runInContext(readFileSync(file, 'utf8'), sandbox, { filename: file })
    }
  }
  runInContext(await readFile(join(outDir, 'sw.js'), 'utf8'), sandbox, { filename: 'sw.js' })
  // sw.js loads the Workbox runtime through its AMD loader, which settles on later microtasks.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
  return listeners
}

/** Whether the worker answers a navigation to `path` itself instead of letting it reach the server. */
function answersNavigation(listeners: FetchListener[], path: string): boolean {
  let answered = false
  // `new Request()` refuses mode 'navigate', so an object on Request's prototype stands in.
  const request = Object.create(Request.prototype, {
    url: { value: `${ORIGIN}${path}` },
    mode: { value: 'navigate' },
    method: { value: 'GET' },
    headers: { value: new Headers() }
  }) as Request
  const event = {
    request,
    respondWith(response: Promise<Response>) {
      answered = true
      response.catch(ignore)
    },
    waitUntil(promise: Promise<unknown>) {
      promise.catch(ignore)
    }
  }
  for (const listener of listeners) listener(event)
  return answered
}

describe('the generated offline worker', () => {
  let outDir = ''
  let listeners: FetchListener[] = []

  beforeAll(async () => {
    outDir = await mkdtemp(join(tmpdir(), 'open-pencil-pwa-'))
    await buildWorker(outDir)
    listeners = await loadWorker(outDir)
  })

  afterAll(async () => {
    if (outDir) await rm(outDir, { recursive: true, force: true })
  })

  test('builds a worker with a fetch handler', async () => {
    expect((await readdir(outDir)).filter((name) => name.startsWith('workbox-'))).toHaveLength(1)
    expect(listeners.length).toBeGreaterThan(0)
  })

  test('serves the cached shell for an editor route', () => {
    expect(answersNavigation(listeners, '/')).toBe(true)
    expect(answersNavigation(listeners, '/file/abc')).toBe(true)
  })

  test('lets a sign-in proxy callback reach the server', () => {
    expect(answersNavigation(listeners, '/oauth2/callback?code=x&state=y')).toBe(false)
    expect(answersNavigation(listeners, '/oauth2/start?rd=%2F')).toBe(false)
  })
})
