import { VitePWA } from 'vite-plugin-pwa'

/**
 * With `serviceWorker` false (`VITE_OPENPENCIL_SERVICE_WORKER=off`) the build emits a
 * self-destroying `/sw.js` in place of the Workbox worker, and `boot.ts` registers nothing.
 */
export function openPencilPwaPlugin({ serviceWorker = true }: { serviceWorker?: boolean } = {}) {
  return VitePWA({
    registerType: 'autoUpdate',
    selfDestroying: !serviceWorker,
    devOptions: { enabled: false },
    workbox: {
      maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
      globPatterns: ['**/*.{js,css,html,wasm,png,svg,ico,ttf,webmanifest}'],
      navigateFallback: '/index.html',
      // A sign-in proxy in front of the editor (oauth2-proxy, for one) owns /oauth2/*. Its
      // callback must reach the server, not the cached shell, or the sign-in never finishes.
      navigateFallbackDenylist: [/^\/oauth2\//]
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
