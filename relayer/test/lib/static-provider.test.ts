// ABOUTME: Unit tests for the static-network provider factory — pins the property that network
// ABOUTME: identity resolves locally (no eth_chainId RPC), which is the whole quota-saving point.

import { expect } from "chai";
import { createStaticProvider } from "../../lib/static-provider";

describe("createStaticProvider", () => {
  it("resolves getNetwork() from the pinned chainId without any RPC call", async () => {
    // WHY: the helper exists to stop ethers v6 from re-verifying chainId over RPC alongside
    // request batches (a large share of RPC quota for a long-running poller). If a regression
    // dropped the staticNetwork option, getNetwork() would need a live endpoint — this test's
    // send() override would throw and the URL (port 0) could never connect anyway.
    const provider = createStaticProvider("http://localhost:0", 11155111);
    provider.send = async () => {
      throw new Error("network detection must not hit the RPC endpoint");
    };

    try {
      const network = await provider.getNetwork();
      expect(network.chainId).to.equal(11155111n);
    } finally {
      provider.destroy();
    }
  });

  it("pins the chainId passed by the caller, per instance", async () => {
    // WHY: each chain's provider must carry ITS OWN chainId — a copy/paste bug that pinned every
    // provider to the same network would make ethers sign transactions with the wrong chainId
    // (EIP-155), which fails at broadcast on every chain but the accidental one.
    const a = createStaticProvider("http://localhost:0", 84532);
    const b = createStaticProvider("http://localhost:0", 421614);
    try {
      expect((await a.getNetwork()).chainId).to.equal(84532n);
      expect((await b.getNetwork()).chainId).to.equal(421614n);
    } finally {
      a.destroy();
      b.destroy();
    }
  });
});
