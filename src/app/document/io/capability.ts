import { IS_BROWSER } from '@/constants'

/**
 * File System Access is Chromium-only today; other browsers download instead. This module is
 * the one place that touches the API, so callers cannot drift on the availability check.
 */
export function supportsFileSystemAccess(): boolean {
  return IS_BROWSER && typeof window.showSaveFilePicker === 'function'
}

/**
 * Brave is Chromium but ships File System Access off by default; `brave://flags/#file-system-access-api`
 * turns it on. Brave exposes `navigator.brave` in every mode, so the banner can name the flag instead
 * of calling the browser unsupported.
 */
export function isBraveBrowser(): boolean {
  return IS_BROWSER && 'brave' in navigator
}

/**
 * Opens the browser save picker. Resolves to null when the browser has no picker, and rejects
 * with `AbortError` when the user cancels so callers can keep cancel and failure distinct.
 */
export async function pickBrowserSaveFile(
  options: FilePickerOptions
): Promise<FileSystemFileHandle | null> {
  // Checked inline rather than through the predicate so TypeScript narrows the method.
  if (!IS_BROWSER || typeof window.showSaveFilePicker !== 'function') return null
  return window.showSaveFilePicker(options)
}
