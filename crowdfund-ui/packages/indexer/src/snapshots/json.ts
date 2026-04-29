// ABOUTME: Deterministic JSON serialization helpers for indexer snapshots.
// ABOUTME: Handles bigint and Map values so graph snapshots can be hashed and published safely.

function normalizeForJson(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Map) {
    return [...value.entries()]
      .sort(([a], [b]) => String(a).localeCompare(String(b)))
      .map(([key, mapValue]) => [key, normalizeForJson(mapValue)])
  }
  if (Array.isArray(value)) return value.map((item) => normalizeForJson(item))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
    for (const [key, item] of entries) out[key] = normalizeForJson(item)
    return out
  }
  return value
}

export function toJsonValue<T>(value: T): unknown {
  return normalizeForJson(value)
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForJson(value), null, 2)
}
