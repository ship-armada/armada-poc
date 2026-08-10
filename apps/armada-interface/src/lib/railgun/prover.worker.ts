// ABOUTME: Web Worker entry for off-main-thread Groth16 proving — runs @armada/sdk's prover handler.
// ABOUTME: snarkjs proves inside this worker; wasm/zkey arrive per prove request from the main thread.

// Import from the LEAN `@armada/sdk/prover` subpath, NOT the root — the root is a 13MB wasm-inlined
// bundle that would balloon the worker chunk and hang the build. This entry is prover + snarkjs only.
import {
  createProverWorkerHandler,
  type ProverWorkerReply,
  type ProverWorkerRequest,
} from '@armada/sdk/prover'

// Cast the worker global rather than pulling the `webworker` lib (it conflicts with the app's DOM lib).
const ctx = self as unknown as {
  postMessage: (reply: ProverWorkerReply) => void
  onmessage: ((event: { data: ProverWorkerRequest }) => void) | null
}

const handle = createProverWorkerHandler((reply) => ctx.postMessage(reply))
ctx.onmessage = (event) => {
  void handle(event.data)
}
