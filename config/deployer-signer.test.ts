// ABOUTME: Unit tests for resolving how the deployer signs on live networks (raw key or Ledger),
// ABOUTME: including the refusal to guess when both or a malformed Ledger address are configured.

import { expect } from "chai";
import { resolveDeployerSigner } from "./deployer-signer";

const LEDGER = "0x00000000000000000000000000000000000000Ab";

describe("resolveDeployerSigner", () => {
  // WHY: the existing hot-key path must keep working unchanged.
  it("returns the private key when only DEPLOYER_PRIVATE_KEY is set", () => {
    expect(resolveDeployerSigner({ DEPLOYER_PRIVATE_KEY: "0xkey" }))
      .to.deep.equal({ kind: "key", privateKey: "0xkey" });
  });

  // WHY: a Ledger deploy names the device address instead of supplying a key.
  it("returns the Ledger address when only DEPLOYER_LEDGER_ADDRESS is set", () => {
    expect(resolveDeployerSigner({ DEPLOYER_LEDGER_ADDRESS: ` ${LEDGER} ` }))
      .to.deep.equal({ kind: "ledger", address: LEDGER });
  });

  // WHY: local runs fall back to the Anvil key elsewhere; this layer only reports "nothing set".
  it("returns none when neither is set (empty strings count as unset)", () => {
    expect(resolveDeployerSigner({})).to.deep.equal({ kind: "none" });
    expect(resolveDeployerSigner({ DEPLOYER_PRIVATE_KEY: "", DEPLOYER_LEDGER_ADDRESS: " " }))
      .to.deep.equal({ kind: "none" });
  });

  // WHY: secrets.env sets DEPLOYER_PRIVATE_KEY by default. If a Ledger address is added on top,
  // Hardhat would list the key's account first and silently deploy from the hot key.
  it("refuses when both a key and a Ledger address are set", () => {
    expect(() => resolveDeployerSigner({ DEPLOYER_PRIVATE_KEY: "0xkey", DEPLOYER_LEDGER_ADDRESS: LEDGER }))
      .to.throw(/not both/);
  });

  // WHY: a typo'd address can never match the device, so fail before any network work.
  for (const bad of ["0x1234", "00000000000000000000000000000000000000Ab", "0xZZ000000000000000000000000000000000000Ab"]) {
    it(`rejects the malformed Ledger address "${bad}"`, () => {
      expect(() => resolveDeployerSigner({ DEPLOYER_LEDGER_ADDRESS: bad }))
        .to.throw(/DEPLOYER_LEDGER_ADDRESS/);
    });
  }
});
