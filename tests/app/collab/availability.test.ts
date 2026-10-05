import { expect, test } from 'bun:test'

import { collaborationAvailable } from '@/app/collab/availability'

test('collaboration is on unless the build turns it off', () => {
  expect(collaborationAvailable(undefined)).toBe(true)
  expect(collaborationAvailable('')).toBe(true)
  expect(collaborationAvailable('on')).toBe(true)
  expect(collaborationAvailable('off')).toBe(false)
  expect(collaborationAvailable(' OFF ')).toBe(false)
})
