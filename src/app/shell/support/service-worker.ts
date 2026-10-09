/**
 * Whether this build installs the offline service worker. A deployment behind a sign-in
 * proxy builds with `VITE_OPENPENCIL_SERVICE_WORKER=off`, because a cached editor opens
 * without passing the proxy once a sign-in lapses. Such a build registers no worker, and
 * its `/sw.js` unregisters any worker a browser already has, deletes the origin's Cache
 * Storage and reloads the tabs it controlled, and holds its activation open until each of
 * those calls has settled. A call the browser rejects is not retried.
 * Documents, kept in IndexedDB and the origin private file system, are untouched.
 */
export function serviceWorkerEnabled(setting: string | undefined): boolean {
  return setting?.trim().toLowerCase() !== 'off'
}
