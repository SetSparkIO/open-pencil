import { join } from 'node:path'

import { VitePWA, type VitePWAOptions } from 'vite-plugin-pwa'

/**
 * Builds `retiring-worker/sw.js` to `/sw.js` as it is, with no precache manifest. It replaces
 * the plugin's own `selfDestroying` worker, whose activate handler starts the unregister and
 * cache deletion without `event.waitUntil`, so the browser may stop it before they finish.
 */
const retiringWorker: Partial<VitePWAOptions> = {
  strategies: 'injectManifest',
  srcDir: join(import.meta.dirname, 'retiring-worker'),
  filename: 'sw.js',
  injectManifest: { injectionPoint: undefined, rollupFormat: 'iife' }
}

/**
 * Pages that are not the editor's: OAuth callbacks, which relay a redirect, and, where a Cloud
 * server serves the editor, its API and its own pages, `CLOUD_PORTAL_PAGE_ROOTS` in
 * `@open-pencil/cloud/contract`, which loads only once packages are built. Workbox matches the
 * path with its query, so a page root may be followed by `?` as well as `/`.
 */
export const NOT_EDITOR_PAGES = [
  /^\/oauth\//,
  // A sign-in proxy in front of the editor (oauth2-proxy, for one) owns /oauth2/*. Its
  // callback must reach the server, not the cached shell, or the sign-in never finishes.
  /^\/oauth2\//,
  /^\/api\//,
  /^\/\.well-known\//,
  /^\/(?:welcome|auth|account|admin)(?:[/?]|$)/
]

/**
 * With `serviceWorker` false (`VITE_OPENPENCIL_SERVICE_WORKER=off`) the build emits the
 * retiring worker as `/sw.js` in place of the Workbox worker, and `boot.ts` registers nothing.
 */
export function openPencilPwaPlugin({ serviceWorker = true }: { serviceWorker?: boolean } = {}) {
  return VitePWA({
    registerType: 'autoUpdate',
    ...(serviceWorker ? {} : retiringWorker),
    devOptions: { enabled: false },
    workbox: {
      maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
      globPatterns: ['**/*.{js,css,html,wasm,png,svg,ico,ttf,webmanifest}'],
      navigateFallback: '/index.html',
      navigateFallbackDenylist: NOT_EDITOR_PAGES
    },
    manifest: {
      name: 'OpenPencil',
      short_name: 'OpenPencil',
      description: 'Open-source design editor',
      display: 'standalone',
      orientation: 'any',
      start_url: '/',
      scope: '/',
      theme_color: '#1e1e1e',
      background_color: '#1e1e1e',
      categories: ['design', 'productivity'],
      icons: [
        { src: '/brand/pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/brand/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        {
          src: '/brand/pwa-maskable-512.png',
          sizes: '512x512',
          type: 'image/png',
          purpose: 'maskable'
        }
      ]
    }
  })
}
