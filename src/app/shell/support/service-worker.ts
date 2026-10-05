/**
 * Whether this build installs the offline service worker. A deployment behind a sign-in
 * proxy builds with `VITE_OPENPENCIL_SERVICE_WORKER=off`, because a cached editor opens
 * without passing the proxy once a sign-in lapses. Such a build registers no worker, and
 * its `/sw.js` unregisters any worker a browser already has, then tries to delete the
 * origin's Cache Storage and reload the tabs it controlled; it does not wait for either.
 * Documents, kept in IndexedDB and the origin private file system, are untouched.
 */
export function serviceWorkerEnabled(setting: string | undefined): boolean {
  return setting?.trim().toLowerCase() !== 'off'
}
