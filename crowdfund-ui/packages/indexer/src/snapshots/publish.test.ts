// ABOUTME: Unit tests for static snapshot publication.
// ABOUTME: Verifies block-addressed artifacts and latest pointers are written with JSON-safe values.

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { buildGraph } from '../../../shared/src/lib/graph.js'
import { publishSnapshot, publishSnapshotToObjectStorage } from './publish.js'
import type { CrowdfundSnapshot } from '../types.js'
import type { PutObjectCommand } from '@aws-sdk/client-s3'

const tempDirs: string[] = []

function makeSnapshot(): CrowdfundSnapshot {
  return {
    metadata: {
      schemaVersion: 1,
      chainId: 11155111,
      contractAddress: '0xf681a7c700420e5ca93f77c8988d3eed02767035',
      deployBlock: 100,
      verifiedBlock: 110,
      verifiedBlockHash: '0x' + '11'.repeat(32),
      snapshotHash: '0x' + '22'.repeat(32),
      generatedAt: '2026-04-28T00:00:00.000Z',
      reconciliation: {
        status: 'passed',
        checkedBlock: 110,
        provider: 'primary',
        checkedAt: '2026-04-28T00:00:01.000Z',
        mismatches: [],
      },
    },
    events: [],
    graph: buildGraph([]),
  }
}

class FakeObjectStorageClient {
  readonly inputs: unknown[] = []

  async send(command: PutObjectCommand): Promise<void> {
    this.inputs.push(command.input)
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('publishSnapshot', () => {
  it('writes snapshot and latest pointer artifacts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crowdfund-snapshot-'))
    tempDirs.push(dir)

    const result = await publishSnapshot(makeSnapshot(), dir)
    const snapshot = JSON.parse(await readFile(result.snapshotPath, 'utf8')) as Record<string, unknown>
    const latest = JSON.parse(await readFile(result.latestPath, 'utf8')) as Record<string, unknown>

    expect(result.snapshotFileName).toBe('snapshot-110.json')
    expect(snapshot.metadata).toMatchObject({ verifiedBlock: 110 })
    expect(latest).toMatchObject({
      verifiedBlock: 110,
      snapshotFile: 'snapshot-110.json',
    })
  })

  it('publishes snapshot and latest pointer to S3-compatible object storage', async () => {
    const client = new FakeObjectStorageClient()

    const result = await publishSnapshotToObjectStorage(makeSnapshot(), {
      bucket: 'armada-snapshots',
      prefix: 'crowdfund/sepolia',
      publicBaseUrl: 'https://snapshots.example.com',
      client,
    })

    expect(result).toMatchObject({
      snapshotPath: 's3://armada-snapshots/crowdfund/sepolia/snapshot-110.json',
      latestPath: 's3://armada-snapshots/crowdfund/sepolia/latest.json',
      snapshotUrl: 'https://snapshots.example.com/crowdfund/sepolia/snapshot-110.json',
      latestUrl: 'https://snapshots.example.com/crowdfund/sepolia/latest.json',
      snapshotFileName: 'snapshot-110.json',
    })
    expect(client.inputs).toHaveLength(2)
    expect(client.inputs[0]).toMatchObject({
      Bucket: 'armada-snapshots',
      Key: 'crowdfund/sepolia/snapshot-110.json',
      ContentType: 'application/json; charset=utf-8',
      CacheControl: 'public, max-age=31536000, immutable',
    })
    expect(client.inputs[1]).toMatchObject({
      Bucket: 'armada-snapshots',
      Key: 'crowdfund/sepolia/latest.json',
      ContentType: 'application/json; charset=utf-8',
      CacheControl: 'public, max-age=60, must-revalidate',
    })
    expect(JSON.parse((client.inputs[1] as { Body: string }).Body)).toMatchObject({
      verifiedBlock: 110,
      snapshotFile: 'snapshot-110.json',
    })
  })
})
