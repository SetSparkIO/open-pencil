/**
 * Whether this build offers Share and Join. A deployment that cannot reach the public
 * signaling brokers (a strict `connect-src`, a private network) builds with
 * `VITE_OPENPENCIL_COLLABORATION=off`, so the editor shows no Share control that would
 * only fail, and a `/share/…` link opens the editor without a join prompt.
 */
export function collaborationAvailable(setting: string | undefined): boolean {
  return setting?.trim().toLowerCase() !== 'off'
}

export const COLLABORATION_AVAILABLE = collaborationAvailable(
  import.meta.env.VITE_OPENPENCIL_COLLABORATION
)
