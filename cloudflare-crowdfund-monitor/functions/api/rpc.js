const PROVIDERS = [
  { name: "Pocket Network", url: "https://eth.api.pocket.network" },
  { name: "PublicNode", url: "https://ethereum-rpc.publicnode.com" },
  { name: "LlamaRPC", url: "https://eth.llamarpc.com" },
];

const TIMEOUT_MS = 12000;

function retryable(payload) {
  const items = Array.isArray(payload) ? payload : [payload];
  return items.some((x) => {
    const e = x && x.error;
    if (!e) return false;
    const m = String(e.message || "").toLowerCase();
    return e.code === -32005 ||
      /rate.?limit|too many requests|timeout|timed out|temporar|upstream|gateway|overloaded|unavailable|connection|internal error/.test(m);
  });
}

async function attempt(provider, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(provider.url, {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json" },
      body,
      signal: controller.signal,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0,200)}`);
    let json;
    try { json = JSON.parse(text); } catch { throw new Error("invalid JSON"); }
    if (retryable(json)) throw new Error("retryable upstream JSON-RPC error");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export async function onRequestPost({ request }) {
  let body;
  try {
    body = await request.text();
    JSON.parse(body);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const errors = [];
  for (let i = 0; i < PROVIDERS.length; i++) {
    try {
      const text = await attempt(PROVIDERS[i], body);
      return new Response(text, {
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          "x-armada-rpc-provider": PROVIDERS[i].name,
          "x-armada-rpc-index": String(i),
        },
      });
    } catch (e) {
      errors.push(`${PROVIDERS[i].name}: ${e.message || e}`);
    }
  }

  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: null,
    error: {
      code: -32098,
      message: "All Ethereum RPC providers failed",
      data: errors,
    },
  }), {
    status: 502,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

export async function onRequestGet() {
  return Response.json({
    ok: true,
    providers: PROVIDERS.map((p, i) => ({ priority: i + 1, name: p.name })),
  });
}
