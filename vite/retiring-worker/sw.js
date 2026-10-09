// The /sw.js of a build without the offline worker (`VITE_OPENPENCIL_SERVICE_WORKER=off`).
// A browser that installed an earlier build's worker fetches this one at its next update check.
// It takes over at once, then unregisters itself, clears the site's Cache Storage and reloads
// the tabs it controls so they load from the server. Activation is held open with waitUntil
// until all of that has settled, so the browser cannot stop the worker partway through.
// Documents saved in the browser live in IndexedDB and are left alone.

self.addEventListener('install', () => {
  void self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(retire())
})

async function retire() {
  await self.registration.unregister()
  const names = await self.caches.keys()
  await Promise.allSettled(names.map((name) => self.caches.delete(name)))
  const tabs = await self.clients.matchAll({ type: 'window' })
  await Promise.allSettled(tabs.map((tab) => tab.navigate(tab.url)))
}
