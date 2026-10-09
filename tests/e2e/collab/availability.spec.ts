import { expect, test, type Page } from '@playwright/test'

import { CanvasHelper } from '#tests/helpers/canvas'

// The app server is built with the environment of this run, so the spec checks whichever
// collaboration mode that build has. Cover both by running it twice:
//   bun run test tests/e2e/collab/availability.spec.ts
//   VITE_OPENPENCIL_COLLABORATION=off bun run test tests/e2e/collab/availability.spec.ts
// This mirrors `collaborationAvailable`, which reads `import.meta.env` and so cannot load here.
const available = process.env.VITE_OPENPENCIL_COLLABORATION?.trim().toLowerCase() !== 'off'
const ROOM_ID = 'e2e-availability-room'

async function openEditor(page: Page, path: string) {
  await page.goto(path)
  await new CanvasHelper(page).waitForInit()
}

test.describe(`collaboration ${available ? 'on (default build)' : 'off'}`, () => {
  test('desktop editor offers Share only when collaboration is on', async ({ page }) => {
    await openEditor(page, '/')
    await expect(page.getByRole('tab', { name: 'Design', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Share', exact: true })).toHaveCount(
      available ? 1 : 0
    )
  })

  test('mobile editor offers Share only when collaboration is on', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await openEditor(page, '/')
    await expect(page.getByRole('button', { name: 'File', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Share', exact: true })).toHaveCount(
      available ? 1 : 0
    )
  })

  test('a share link prompts to join only when collaboration is on', async ({ page }) => {
    await openEditor(page, `/share/${ROOM_ID}`)
    const prompt = page.getByRole('dialog', { name: 'Join room' })
    if (available) {
      await expect(page).toHaveURL(`/share/${ROOM_ID}`)
      await expect(prompt).toBeVisible()
      await expect(prompt.getByText('Join collaboration', { exact: true })).toBeVisible()
      await expect(prompt.getByRole('textbox', { name: 'Enter your name' })).toBeVisible()
    } else {
      await expect(page).toHaveURL('/')
      await expect(page.getByRole('tab', { name: 'Design', exact: true })).toBeVisible()
      await expect(prompt).toHaveCount(0)
      await expect(page.getByRole('button', { name: /join|share/i })).toHaveCount(0)
    }
  })
})
