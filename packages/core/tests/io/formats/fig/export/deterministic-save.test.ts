import { afterEach, expect, setSystemTime, test } from 'bun:test'

import { exportFigFile } from '@open-pencil/core/io'
import { initCodec } from '@open-pencil/core/kiwi'
import { parseFigBuffer } from '@open-pencil/fig'
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
  expect(parseFigBuffer(first.buffer as ArrayBuffer).metaJSON).toBe(
    '{"version":1,"app":"OpenPencil"}'
  )
})
