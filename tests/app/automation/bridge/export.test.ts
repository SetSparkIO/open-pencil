import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { toUint8Array } from 'js-base64'

import { SkiaRenderer } from '@open-pencil/core/canvas'
import { initCanvasKit } from '@open-pencil/core/io'

import { makeFigmaFromStore } from '@/app/automation/bridge/figma-factory'
import type { AutomationTarget } from '@/app/automation/bridge/target'
import { createAutomationToolHandler } from '@/app/automation/bridge/tool-handlers'
import { createEditorStore, type EditorStore } from '@/app/editor/session/create'

const RED = { type: 'SOLID' as const, color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1, visible: true }

let stores: EditorStore[] = []

beforeEach(() => {
  // The automation FigmaAPI reads the viewport size from the window.
  Object.assign(globalThis, { window: { innerWidth: 1024, innerHeight: 768 } })
})

afterEach(() => {
  for (const store of stores) store.dispose()
  stores = []
  Reflect.deleteProperty(globalThis, 'window')
})

async function storeWithCanvas(): Promise<EditorStore> {
  const store = createEditorStore()
  stores.push(store)
  const ck = await initCanvasKit()
  const surface = ck.MakeSurface(1, 1)
  if (!surface) throw new Error('Failed to create CanvasKit surface')
  store.setCanvasKit(ck, new SkiaRenderer(ck, surface))
  return store
}

function target(store: EditorStore, pageId: string): AutomationTarget {
  const page = store.graph.getNode(pageId)
  return {
    store,
    documentId: 'tab-1',
    documentName: 'Document',
    pageId,
    pageName: page?.name ?? ''
  }
}

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

function resultBytes(response: unknown): Uint8Array {
  const result = (response as { result?: { base64?: string } }).result
  if (!result?.base64) throw new Error(`No image in ${JSON.stringify(response)}`)
  return toUint8Array(result.base64)
}

describe('automation export of a page that is not on screen', () => {
  test('export_image renders nodes by ID from another page', async () => {
    const store = await storeWithCanvas()
    const shown = store.state.currentPageId
    const other = store.graph.addPage('Other').id
    const frame = store.graph.createNode('FRAME', other, { width: 40, height: 30, fills: [RED] })
    const handleTool = createAutomationToolHandler(makeFigmaFromStore)

    const response = await handleTool(target(store, shown), {
      name: 'export_image',
      args: { ids: [frame.id] }
    })

    expect(pngSize(resultBytes(response))).toEqual({ width: 40, height: 30 })
    expect(store.state.currentPageId).toBe(shown)
  })

  test('export_image renders the layers of the page named by page_id', async () => {
    const store = await storeWithCanvas()
    const shown = store.state.currentPageId
    const other = store.graph.addPage('Other').id
    store.graph.createNode('FRAME', other, { width: 50, height: 20, fills: [RED] })
    const handleTool = createAutomationToolHandler(makeFigmaFromStore)

    const response = await handleTool(target(store, other), { name: 'export_image', args: {} })

    expect(pngSize(resultBytes(response))).toEqual({ width: 50, height: 20 })
    expect(store.state.currentPageId).toBe(shown)
  })
})
