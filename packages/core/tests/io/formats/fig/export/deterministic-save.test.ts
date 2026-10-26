import { afterEach, expect, setSystemTime, test } from 'bun:test'

import { exportFigFile } from '@open-pencil/core/io/formats/fig'
import { parseFigBuffer } from '@open-pencil/fig'
import { initCodec } from '@open-pencil/kiwi/fig/codec'
import { SceneGraph } from '@open-pencil/scene-graph'

afterEach(() => {
  setSystemTime()
})

test('saves an unchanged document to the same bytes at any time', async () => {
  await initCodec()
  const graph = new SceneGraph()
  graph.createNode('FRAME', graph.getPages()[0].id, { name: 'Frame', width: 100, height: 80 })

  setSystemTime(new Date('2026-01-02T03:04:05Z'))
  const first = await exportFigFile(graph)
  setSystemTime(new Date('2027-06-07T22:09:10Z'))
  const second = await exportFigFile(graph)

  expect(second).toEqual(first)
  const meta: unknown = JSON.parse(parseFigBuffer(first.buffer as ArrayBuffer).metaJSON)
  expect(meta).toMatchObject({ exported_at: '1980-01-01T00:00:00.000Z' })
})
