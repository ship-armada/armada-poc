// ABOUTME: Unit tests for scannerConfigForChain — pins chainId-based chain-type classification
// ABOUTME: and the RELAYER_<KNOB>_<NAME> env-override key derivation (HUB, CLIENT_A, CLIENT_B).

import { expect } from "chai";
import { scannerConfigForChain } from "../config";

describe("scannerConfigForChain", () => {
  afterEach(() => {
    // Each test that sets override envs must not leak into the next.
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("RELAYER_")) delete process.env[key];
    }
  });

  it("classifies Ethereum Sepolia (hub) as L1: confirmationDepth 6, bootLookback 150", () => {
    // WHY: chain-type defaults previously matched regexes against the config names ("Hub",
    // "Client A", ...), which NEVER matched — every chain silently got the fallback defaults,
    // including confirmationDepth 2 on Ethereum L1 where the design intent is 6 (reorg margin).
    // This pins classification by chainId so role labels can't break it again.
    const scanner = scannerConfigForChain("Hub", "sepolia", 11155111);
    expect(scanner.confirmationDepth).to.equal(6);
    expect(scanner.bootLookbackBlocks).to.equal(150);
    expect(scanner.maxBootLookbackBlocks).to.equal(1500);
    expect(scanner.maxLogRange).to.equal(1000);
  });

  it("classifies Base Sepolia as base-like: confirmationDepth 2, bootLookback 900", () => {
    // WHY: ~2s blocks → 900 blocks ≈ 30 min of cold-boot recovery, per the design comment.
    const scanner = scannerConfigForChain("Client A", "sepolia", 84532);
    expect(scanner.confirmationDepth).to.equal(2);
    expect(scanner.bootLookbackBlocks).to.equal(900);
    expect(scanner.maxBootLookbackBlocks).to.equal(9000);
  });

  it("classifies Arbitrum Sepolia as arb-like: confirmationDepth 2, bootLookback 7200", () => {
    // WHY: ~0.25s blocks → 7200 blocks ≈ 30 min. Under the old name-regex bug this chain got
    // 300 blocks (~75 seconds) of cold-boot recovery — messages sent during any longer relayer
    // downtime were silently skipped.
    const scanner = scannerConfigForChain("Client B", "sepolia", 421614);
    expect(scanner.confirmationDepth).to.equal(2);
    expect(scanner.bootLookbackBlocks).to.equal(7200);
    expect(scanner.maxBootLookbackBlocks).to.equal(72000);
  });

  it("falls back to conservative defaults for an unrecognized chainId", () => {
    // WHY: a new chain added to config before its chainId is classified must still get sane
    // scanner behavior (lookback 300 ≈ generic 30 min at 6s blocks, confirmation 2), not a crash.
    const scanner = scannerConfigForChain("Client B", "sepolia", 99999);
    expect(scanner.confirmationDepth).to.equal(2);
    expect(scanner.bootLookbackBlocks).to.equal(300);
    expect(scanner.maxBootLookbackBlocks).to.equal(3000);
  });

  it("uses Anvil-tuned values for local env regardless of chainId", () => {
    // WHY: local Anvil has no reorgs and no RPC range caps — chunking/confirmation-depth would
    // only slow tests down. The local branch must win before any chainId classification.
    const scanner = scannerConfigForChain("Hub", "local", 31337);
    expect(scanner.confirmationDepth).to.equal(0);
    expect(scanner.maxLogRange).to.equal(10000);
    expect(scanner.bootLookbackBlocks).to.equal(0);
  });

  it("honours env overrides keyed by the config name (HUB, CLIENT_A), not the network name", () => {
    // WHY: operators set RELAYER_<KNOB>_HUB / _CLIENT_A / _CLIENT_B on the VPS. The suffix
    // derives from the chain's config `name` — this pins the derivation ("Client A" → CLIENT_A)
    // so a rename of the config labels surfaces as a test failure, not silently ignored envs.
    process.env.RELAYER_CONFIRMATION_DEPTH_HUB = "3";
    process.env.RELAYER_MAX_LOG_RANGE_CLIENT_A = "10";

    const hub = scannerConfigForChain("Hub", "sepolia", 11155111);
    expect(hub.confirmationDepth).to.equal(3);

    const clientA = scannerConfigForChain("Client A", "sepolia", 84532);
    expect(clientA.maxLogRange).to.equal(10);
    // Un-overridden knobs keep their chain-type defaults.
    expect(clientA.bootLookbackBlocks).to.equal(900);
  });

  it("rejects a non-numeric env override loudly", () => {
    // WHY: a typo'd override (e.g. "1O0") silently falling back to the default would be a
    // misconfiguration the operator can't see. Boot-time throw is the visible failure mode.
    process.env.RELAYER_MAX_LOG_RANGE_HUB = "not-a-number";
    expect(() => scannerConfigForChain("Hub", "sepolia", 11155111)).to.throw(
      /RELAYER_MAX_LOG_RANGE_HUB/,
    );
  });
});
