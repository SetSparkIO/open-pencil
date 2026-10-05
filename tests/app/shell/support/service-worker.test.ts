import { expect, test } from 'bun:test'

import { serviceWorkerEnabled } from '@/app/shell/support/service-worker'

test('the service worker is on unless the build turns it off', () => {
  expect(serviceWorkerEnabled(undefined)).toBe(true)
  expect(serviceWorkerEnabled('')).toBe(true)
  expect(serviceWorkerEnabled('on')).toBe(true)
  expect(serviceWorkerEnabled('off')).toBe(false)
  expect(serviceWorkerEnabled(' OFF ')).toBe(false)
})
