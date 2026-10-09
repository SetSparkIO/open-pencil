import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext, runInContext } from 'node:vm'

import { openPencilPwaPlugin } from '#vite-config/pwa'
import { resolveConfig, type Plugin } from 'vite'
import type { VitePluginPWAAPI } from 'vite-plugin-pwa'

const ORIGIN = 'https://editor.example'
const CACHE_NAMES = ['workbox-precache-v2-https://editor.example/', 'workbox-runtime']
const TAB_URLS = [`${ORIGIN}/`, `${ORIGIN}/file/abc`]
const ignore = () => undefined

type Listener = (event: { waitUntil: (promise: Promise<unknown>) => void }) => void

/** Builds the `/sw.js` of a build with the offline worker turned off into `root/dist`. */
async function buildWorker(root: string): Promise<string> {
  const outDir = join(root, 'dist')
  await writeFile(join(root, 'index.html'), '<!doctype html><title>shell</title>')
  // The app build has written its bundle there by the time the worker is generated.
  await mkdir(outDir)
  // As in pwa-worker.test.ts: `vite build` sets NODE_ENV, and the bundler replaces
  // Error.prepareStackTrace for the whole process; both are put back afterwards.
  const nodeEnv = process.env.NODE_ENV
  const prepareStackTrace = Error.prepareStackTrace
  process.env.NODE_ENV = 'production'
  try {
    const config = await resolveConfig(
      {
        configFile: false,
        root,
        logLevel: 'silent',
        plugins: [openPencilPwaPlugin({ serviceWorker: false })],
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
    return outDir
  } finally {
    if (nodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = nodeEnv
    Error.prepareStackTrace = prepareStackTrace
  }
}

/**
 * Runs the built `sw.js` in a sandbox standing in for a service worker global. Each call the
 * worker makes to its registration, caches or tabs stays pending until `drive` finishes it.
 */
async function loadWorker(outDir: string) {
  const listeners = new Map<string, Listener[]>()
  const pending: Array<() => void> = []
  const done = {
    skipWaiting: false,
    unregistered: false,
    deleted: [] as string[],
    reloaded: [] as string[]
  }
  function held<T>(value: T, record: () => void = ignore): Promise<T> {
    return new Promise((resolve) => {
      pending.push(() => {
        record()
        resolve(value)
      })
    })
  }
  const self: Record<string, unknown> = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener(type: string, listener: Listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener])
    },
    registration: {
      scope: `${ORIGIN}/`,
      unregister: () => held(true, () => (done.unregistered = true))
    },
    skipWaiting() {
      done.skipWaiting = true
      return held(undefined)
    },
    caches: {
      keys: () => held([...CACHE_NAMES]),
      delete: (name: string) => held(true, () => done.deleted.push(name))
    },
    clients: {
      matchAll: () =>
        held(
          TAB_URLS.map((url) => ({
            url,
            navigate: (to: string) => held(null, () => done.reloaded.push(to))
          }))
        )
    },
    importScripts() {
      throw new Error('the retiring worker loads no scripts')
    },
    console
  }
  const sandbox = createContext(self)
  self.self = sandbox
  runInContext(await readFile(join(outDir, 'sw.js'), 'utf8'), sandbox, { filename: 'sw.js' })

  /**
   * Finishes the worker's pending calls one at a time, newest first, until `waited` settles.
   * A call the worker started without awaiting is older than those after it, so it is still
   * pending when `waited` settles. Returns the number of calls left pending at that point.
   */
  async function drive(waited: Promise<unknown>): Promise<number> {
    let settled = false
    void waited.then(() => (settled = true))
    for (;;) {
      await new Promise((resolve) => {
        setTimeout(resolve, 0)
      })
      if (settled) return pending.length
      const next = pending.pop()
      if (!next) throw new Error('the worker is waiting on nothing, but activation never ended')
      next()
    }
  }

  return { listeners, done, drive }
}

/** Dispatches `type` and returns the promises the worker passed to `waitUntil`. */
function dispatch(listeners: Map<string, Listener[]>, type: string): Promise<unknown>[] {
  const waited: Promise<unknown>[] = []
  for (const listener of listeners.get(type) ?? []) {
    listener({ waitUntil: (promise) => waited.push(promise) })
  }
  return waited
}

describe('the worker of a build without the offline worker', () => {
  let root = ''
  let outDir = ''

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'open-pencil-pwa-off-'))
    outDir = await buildWorker(root)
  })

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true })
  })

  test('is emitted as /sw.js with no Workbox runtime or precache list', async () => {
    const files = await readdir(outDir)
    expect(files).toContain('sw.js')
    expect(files.filter((name) => name.startsWith('workbox-') || name === 'sw.mjs')).toEqual([])
    expect(await readFile(join(outDir, 'sw.js'), 'utf8')).not.toContain('__WB_MANIFEST')
  })

  test('takes over from the old worker as soon as it is installed', async () => {
    const { listeners, done } = await loadWorker(outDir)
    dispatch(listeners, 'install')
    expect(done.skipWaiting).toBe(true)
  })

  test('keeps activation open until it has unregistered, cleared the caches and reloaded the tabs', async () => {
    const { listeners, done, drive } = await loadWorker(outDir)
    const waited = dispatch(listeners, 'activate')
    expect(waited).toHaveLength(1)

    expect(await drive(Promise.all(waited))).toBe(0)
    expect(done.unregistered).toBe(true)
    expect(done.deleted.toSorted()).toEqual([...CACHE_NAMES].sort())
    expect(done.reloaded.toSorted()).toEqual([...TAB_URLS].sort())
  })
})
