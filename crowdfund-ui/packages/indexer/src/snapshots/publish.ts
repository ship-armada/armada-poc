// ABOUTME: Static snapshot artifact publishing for the crowdfund indexer.
// ABOUTME: Writes block-addressed snapshot files and atomically advances the latest pointer.

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stableStringify, toJsonValue } from './json.js'
import type { CrowdfundSnapshot } from '../types.js'
import type { PutObjectCommandInput } from '@aws-sdk/client-s3'

export interface PublishSnapshotResult {
  snapshotPath: string
  latestPath: string
  snapshotFileName: string
  snapshotUrl?: string
  latestUrl?: string
}

export interface ObjectStoragePublishOptions {
  bucket: string
  prefix?: string
  region?: string
  endpoint?: string
  publicBaseUrl?: string
  forcePathStyle?: boolean
  snapshotCacheControl?: string
  latestCacheControl?: string
  client?: ObjectStorageClient
}

export interface ObjectStorageClient {
  send(command: PutObjectCommand): Promise<unknown>
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmpPath = `${path}.${process.pid}.tmp`
  await writeFile(tmpPath, `${stableStringify(value)}\n`, 'utf8')
  await rename(tmpPath, path)
}

function getSnapshotFileName(snapshot: CrowdfundSnapshot): string {
  return `snapshot-${snapshot.metadata.verifiedBlock}.json`
}

function createLatestPointer(snapshot: CrowdfundSnapshot, snapshotFileName: string): Record<string, unknown> {
  return {
    schemaVersion: snapshot.metadata.schemaVersion,
    chainId: snapshot.metadata.chainId,
    contractAddress: snapshot.metadata.contractAddress,
    deployBlock: snapshot.metadata.deployBlock,
    verifiedBlock: snapshot.metadata.verifiedBlock,
    snapshotHash: snapshot.metadata.snapshotHash,
    generatedAt: snapshot.metadata.generatedAt,
    snapshotFile: snapshotFileName,
  }
}

function normalizePrefix(prefix: string | undefined): string {
  if (!prefix) return ''
  return prefix.replace(/^\/+|\/+$/g, '')
}

function objectKey(prefix: string | undefined, fileName: string): string {
  const normalized = normalizePrefix(prefix)
  return normalized ? `${normalized}/${fileName}` : fileName
}

function s3Uri(bucket: string, key: string): string {
  return `s3://${bucket}/${key}`
}

function objectUrl(publicBaseUrl: string | undefined, key: string): string | undefined {
  if (!publicBaseUrl) return undefined
  return `${publicBaseUrl.replace(/\/+$/g, '')}/${key}`
}

function createS3Client(options: ObjectStoragePublishOptions): ObjectStorageClient {
  return options.client ?? new S3Client({
    region: options.region,
    endpoint: options.endpoint,
    forcePathStyle: options.forcePathStyle,
  })
}

async function putJsonObject(
  client: ObjectStorageClient,
  input: Omit<PutObjectCommandInput, 'Body' | 'ContentType'> & { value: unknown },
): Promise<void> {
  await client.send(new PutObjectCommand({
    ...input,
    Body: `${stableStringify(input.value)}\n`,
    ContentType: 'application/json; charset=utf-8',
  }))
}

export async function publishSnapshot(
  snapshot: CrowdfundSnapshot,
  outputDir: string,
): Promise<PublishSnapshotResult> {
  await mkdir(outputDir, { recursive: true })
  const snapshotFileName = getSnapshotFileName(snapshot)
  const snapshotPath = join(outputDir, snapshotFileName)
  const latestPath = join(outputDir, 'latest.json')
  const jsonSnapshot = toJsonValue(snapshot)

  await writeJsonAtomic(snapshotPath, jsonSnapshot)
  await writeJsonAtomic(latestPath, createLatestPointer(snapshot, snapshotFileName))

  return { snapshotPath, latestPath, snapshotFileName }
}

export async function publishSnapshotToObjectStorage(
  snapshot: CrowdfundSnapshot,
  options: ObjectStoragePublishOptions,
): Promise<PublishSnapshotResult> {
  if (!options.bucket) throw new Error('Missing object storage bucket')

  const client = createS3Client(options)
  const snapshotFileName = getSnapshotFileName(snapshot)
  const snapshotKey = objectKey(options.prefix, snapshotFileName)
  const latestKey = objectKey(options.prefix, 'latest.json')
  const jsonSnapshot = toJsonValue(snapshot)
  const latestPointer = createLatestPointer(snapshot, snapshotFileName)

  await putJsonObject(client, {
    Bucket: options.bucket,
    Key: snapshotKey,
    value: jsonSnapshot,
    CacheControl: options.snapshotCacheControl ?? 'public, max-age=31536000, immutable',
  })
  await putJsonObject(client, {
    Bucket: options.bucket,
    Key: latestKey,
    value: latestPointer,
    CacheControl: options.latestCacheControl ?? 'public, max-age=60, must-revalidate',
  })

  const snapshotPath = s3Uri(options.bucket, snapshotKey)
  const latestPath = s3Uri(options.bucket, latestKey)
  return {
    snapshotPath,
    latestPath,
    snapshotFileName,
    snapshotUrl: objectUrl(options.publicBaseUrl, snapshotKey),
    latestUrl: objectUrl(options.publicBaseUrl, latestKey),
  }
}
