// ABOUTME: Error-message sanitization for the crowdfund indexer.
// ABOUTME: Strips RPC URL paths/queries and DB credentials so secrets never reach logs or the API.

const MAX_LENGTH = 500

// Redacts secrets that commonly travel inside error messages before they are persisted
// (lastError) or returned to clients. RPC providers embed API keys in the URL path/query
// (Alchemy/Infura), and connection errors embed DB credentials in userinfo. Neither
// belongs in a stored field served by the unauthenticated /health endpoint.
export function sanitizeErrorMessage(message: string): string {
  let out = message

  // 1. Redact credentials in any `scheme://user:pass@host` userinfo segment.
  out = out.replace(/\b([a-z][a-z0-9+.-]*):\/\/[^/\s@]*@/gi, '$1://[redacted]@')

  // 2. Strip path/query/fragment from http(s)/ws(s) URLs — that is where RPC keys live.
  //    Keep scheme+host so the message still says which provider failed.
  out = out.replace(
    /\b((?:https?|wss?):\/\/[^/?#\s"')]+)([/?#][^\s"')]*)?/gi,
    (_match, base: string, rest: string | undefined) => (rest ? `${base}/[redacted]` : base),
  )

  if (out.length > MAX_LENGTH) out = `${out.slice(0, MAX_LENGTH)}…(truncated)`
  return out
}
