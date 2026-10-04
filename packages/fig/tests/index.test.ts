import { beforeAll, describe, expect, it, setSystemTime } from 'bun:test'

import {
  FIG_PACKAGE_STATUS,
  parseFigBuffer,
  readFigContainer,
  writeFigArchive,
  writeFigContainer
} from '#fig/index'
import { deflateSync } from 'fflate'

import {
  createNodeChangesMessage,
  encodeMessage,
  getSchemaBytes,
  initCodec
} from '@open-pencil/kiwi/fig/codec'

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function appendChunk(container: Uint8Array, chunk: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(container.byteLength + 4 + chunk.byteLength)
  bytes.set(container)
  new DataView(bytes.buffer).setUint32(container.byteLength, chunk.byteLength, true)
  bytes.set(chunk, container.byteLength + 4)
  return bytes
}

describe('@open-pencil/fig package API', () => {
  beforeAll(async () => {
    await initCodec()
  })

  it('exports archive API status', () => {
    expect(FIG_PACKAGE_STATUS).toBe('document-reader')
  })

  it('round-trips fig-kiwi container bytes', () => {
    const bytes = writeFigContainer({
      schemaDeflated: new Uint8Array([1, 2, 3]),
      dataRaw: new Uint8Array([4, 5, 6])
    })
    const document = readFigContainer(bytes, { fileName: 'fixture.fig' })

    expect(document.schemaDeflated).toEqual(new Uint8Array([1, 2, 3]))
    expect(document.dataRaw).toEqual(new Uint8Array([4, 5, 6]))
    expect(document.source?.bytes).toBe(bytes)
    expect(document.source?.fileName).toBe('fixture.fig')
  })

  it('parses complete .fig archives and image resources', () => {
    const thumbnailPNG = new Uint8Array([1])
    const metaJSON = '{}'
    const bytes = writeFigArchive({
      schemaDeflated: deflateSync(getSchemaBytes()),
      kiwiData: encodeMessage(
        createNodeChangesMessage(0, 0, [
          {
            guid: { sessionID: 0, localID: 0 },
            type: 'DOCUMENT',
            phase: 'CREATED',
            name: 'Document'
          }
        ])
      ),
      thumbnailPNG,
      metaJSON,
      images: [{ name: 'images/hash', data: new Uint8Array([9, 8, 7]) }]
    })
    const parsed = parseFigBuffer(bytes.buffer as ArrayBuffer)

    expect(parsed.nodeChanges).toHaveLength(1)
    expect(parsed.nodeChanges[0]?.type).toBe('DOCUMENT')
    expect(parsed.images).toEqual([['hash', new Uint8Array([9, 8, 7])]])
    expect(parsed.thumbnailPNG).toEqual(thumbnailPNG)
    expect(parsed.metaJSON).toBe(metaJSON)
  })

  it('writes the same archive bytes at any time, with every entry dated 1980-01-01', () => {
    const input = {
      schemaDeflated: deflateSync(getSchemaBytes()),
      kiwiData: encodeMessage(
        createNodeChangesMessage(0, 0, [
          {
            guid: { sessionID: 0, localID: 0 },
            type: 'DOCUMENT',
            phase: 'CREATED',
            name: 'Document'
          }
        ])
      ),
      thumbnailPNG: new Uint8Array([...PNG_SIGNATURE, 1, 2, 3]),
      metaJSON: '{"version":1}',
      images: [{ name: 'images/hash', data: new Uint8Array([9, 8, 7]) }]
    }
    try {
      setSystemTime(new Date('2026-01-02T03:04:05Z'))
      const first = writeFigArchive(input)
      setSystemTime(new Date('2027-06-07T22:09:10Z'))
      const second = writeFigArchive(input)

      expect(second).toEqual(first)
      // The first local file header holds the entry's DOS time at offset 10 and date at 12.
      const header = new DataView(first.buffer, first.byteOffset)
      expect(header.getUint16(10, true)).toBe(0)
      expect(header.getUint16(12, true)).toBe((1 << 5) | 1)
    } finally {
      setSystemTime()
    }
  })

  it('parses legacy raw fig-kiwi files and preserves their thumbnail chunk', () => {
    const container = writeFigContainer(
      {
        schemaDeflated: deflateSync(getSchemaBytes()),
        dataRaw: encodeMessage(
          createNodeChangesMessage(0, 0, [
            {
              guid: { sessionID: 0, localID: 0 },
              type: 'DOCUMENT',
              phase: 'CREATED',
              name: 'Document'
            }
          ])
        )
      },
      { version: 1 }
    )
    const thumbnailPNG = new Uint8Array([...PNG_SIGNATURE, 1, 2, 3])
    const bytes = appendChunk(container, thumbnailPNG)
    const parsed = parseFigBuffer(bytes.buffer as ArrayBuffer)

    expect(parsed.nodeChanges).toHaveLength(1)
    expect(parsed.figKiwiVersion).toBe(1)
    expect(parsed.images).toEqual([])
    expect(parsed.thumbnailPNG).toEqual(thumbnailPNG)
    expect(parsed.metaJSON).toBeNull()
  })

  it('rejects invalid fig-kiwi containers', () => {
    expect(() => readFigContainer(new Uint8Array([1, 2, 3]))).toThrow('Invalid fig-kiwi')
  })
})
