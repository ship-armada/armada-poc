/**
 * Vector recording engine.
 *
 * Each recorded vector captures, for ONE user-visible call:
 *   - full calldata (hex) + decoded call
 *   - ordered emitted events (address, topics, data, logIndex + best-effort decode)
 *   - pre/post state reads (spec §12 invariants: treeNumber, nextLeafIndex,
 *     merkleRoot, lastEventBlock, nullifiers/rootHistory entries touched,
 *     token balances of pool/user/treasury/relayer, config slots for admin ops)
 *   - return data or the exact revert reason/selector
 *   - gas used
 *
 * Output: one JSON per vector in test-foundry/fixtures/contract-vectors/ plus a
 * manifest.json with dependency order, written by the caller via finalize().
 */

import { ethers } from "hardhat";
import { Interface, Signer } from "ethers";
import * as path from "path";
import { normalize, toHex, writeJSON } from "./util";

export interface StateRead {
  key: string;
  read: () => Promise<any>;
}

export interface VectorMeta {
  id: string;
  category: string;
  description: string;
  specRefs?: string[];
  /** true when the pool's testingMode proof bypass was active for this vector. */
  proofsBypassed?: boolean;
  dependsOn?: string[];
  /** Human-readable ordered setup prerequisites (funding, approvals, config). */
  setup?: string[];
  /** Address-book label that must be impersonated to replay this vector. */
  requiresImpersonation?: string;
}

export interface SetupTx {
  from: Signer;
  fromLabel: string;
  to: string;
  toLabel: string;
  calldata: string;
  description: string;
}

export interface CaptureRequest {
  meta: VectorMeta;
  /** Executable prerequisite transactions (mock flag flips etc.), sent and
   *  mined immediately before the vector's own tx and recorded in the vector
   *  file so replay can reproduce the exact pre-state. */
  setupTxs?: SetupTx[];
  from: Signer;
  fromLabel: string;
  to: string;
  toLabel: string;
  calldata: string;
  decodedCall?: any;
  expectRevert?: boolean;
  /** Expected revert reason substring — logged as a warning on mismatch only. */
  expectReason?: string;
  gasLimit?: bigint;
  preReads?: StateRead[];
  postReads?: StateRead[];
  /** [label, address] pairs for USDC balanceOf reads (pre + post). */
  balancesOf?: Array<[string, string]>;
  /** Capture return data via eth_call before sending (view-returning ops). */
  captureReturnData?: boolean;
}

export interface ManifestEntry {
  id: string;
  file: string;
  category: string;
  dependsOn: string[];
  proofsBypassed: boolean;
  outcome: "success" | "revert";
  revertReason?: string;
  description: string;
}

interface RecorderOpts {
  outDir: string;
  // Untyped on purpose: typechain-typed contracts clash with plain-object calls.
  pool: any; // PrivacyPool router (for base invariant reads)
  usdc: any;
  decoders: Interface[]; // ABIs used for best-effort event decoding
  addressBook: Record<string, string>;
  chainId: number;
  deployments: Record<string, string>; // deployment manifest filenames
}

export class Recorder {
  readonly entries: ManifestEntry[] = [];
  private opts: RecorderOpts;

  constructor(opts: RecorderOpts) {
    this.opts = opts;
  }

  private async snapshot(reads: StateRead[]): Promise<Record<string, any>> {
    const out: Record<string, any> = {};
    for (const r of reads) {
      out[r.key] = normalize(await r.read());
    }
    return out;
  }

  private baseReads(balancesOf: Array<[string, string]>): StateRead[] {
    const { pool, usdc } = this.opts;
    const reads: StateRead[] = [
      { key: "pool.treeNumber", read: () => pool.treeNumber() },
      { key: "pool.nextLeafIndex", read: () => pool.nextLeafIndex() },
      { key: "pool.merkleRoot", read: () => pool.merkleRoot() },
      { key: "pool.lastEventBlock", read: () => pool.lastEventBlock() },
    ];
    for (const [label, addr] of balancesOf) {
      reads.push({ key: `usdc.balanceOf[${label}]`, read: () => usdc.balanceOf(addr) });
    }
    return reads;
  }

  /** Extract revert return-data from an ethers v6 call exception. */
  private extractRevertData(err: any): string | null {
    const candidates = [
      err?.data,
      err?.info?.error?.data,
      err?.error?.data,
      err?.info?.error?.error?.data,
    ];
    for (const c of candidates) {
      if (typeof c === "string" && c.startsWith("0x")) return c;
    }
    return null;
  }

  private decodeRevert(data: string | null): {
    kind: string;
    reason?: string;
    panicCode?: string;
    data: string | null;
  } {
    if (!data || data === "0x") return { kind: "unknown", data };
    const selector = data.slice(0, 10);
    if (selector === "0x08c379a0") {
      try {
        const [reason] = ethers.AbiCoder.defaultAbiCoder().decode(
          ["string"],
          "0x" + data.slice(10)
        );
        return { kind: "Error(string)", reason, data };
      } catch {
        return { kind: "Error(string)", data };
      }
    }
    if (selector === "0x4e487b71") {
      try {
        const [code] = ethers.AbiCoder.defaultAbiCoder().decode(
          ["uint256"],
          "0x" + data.slice(10)
        );
        return { kind: "Panic(uint256)", panicCode: toHex(code), data };
      } catch {
        return { kind: "Panic(uint256)", data };
      }
    }
    return { kind: `custom(selector=${selector})`, data };
  }

  private decodeEvents(receipt: any): any[] {
    return receipt.logs.map((log: any) => {
      const entry: any = {
        logIndex: log.index,
        address: log.address,
        topics: log.topics,
        data: log.data,
      };
      for (const iface of this.opts.decoders) {
        try {
          const parsed = iface.parseLog({ topics: log.topics, data: log.data });
          if (parsed) {
            entry.decoded = { name: parsed.name, args: normalize(parsed.args) };
            break;
          }
        } catch {
          // not this contract's event — try next decoder
        }
      }
      return entry;
    });
  }

  async capture(req: CaptureRequest): Promise<void> {
    const { meta } = req;

    // Execute and mine executable setup transactions first. A null/empty `to`
    // is a contract-creation tx (deterministic address from sender nonce).
    for (const s of req.setupTxs ?? []) {
      const rcpt = await (await s.from.sendTransaction({ ...(s.to ? { to: s.to } : {}), data: s.calldata, value: 0 })).wait();
      if (rcpt!.status !== 1) throw new Error(`[${meta.id}] setupTx failed: ${s.description}`);
    }

    const preState = await this.snapshot([
      ...this.baseReads(req.balancesOf ?? []),
      ...(req.preReads ?? []),
    ]);

    // Return data (for ops that return values) or the revert reason, via eth_call.
    let returnData: string | null = null;
    let revert: ReturnType<Recorder["decodeRevert"]> | null = null;
    try {
      returnData = await ethers.provider.call({
        to: req.to,
        data: req.calldata,
        from: await req.from.getAddress(),
      });
    } catch (err: any) {
      revert = this.decodeRevert(this.extractRevertData(err));
      if (!req.expectRevert) {
        throw new Error(
          `[${meta.id}] unexpected eth_call failure: ${revert.reason ?? revert.kind}`
        );
      }
      if (
        req.expectReason &&
        !(revert.reason ?? "").includes(req.expectReason)
      ) {
        console.warn(
          `  [${meta.id}] WARNING: revert reason "${revert.reason ?? revert.kind}" ` +
            `does not contain expected "${req.expectReason}"`
        );
      }
    }

    // Send the transaction for real so gas + events + state transitions are recorded.
    const txResponse = await req.from.sendTransaction({
      to: req.to,
      data: req.calldata,
      value: 0,
      // Explicit gas limit for expected reverts skips eth_estimateGas (which would throw).
      ...(req.expectRevert ? { gasLimit: req.gasLimit ?? 6_000_000n } : {}),
    });

    let receipt: any = null;
    try {
      receipt = await txResponse.wait();
    } catch (err: any) {
      // ethers throws when the mined tx reverted; fetch the receipt directly.
      if (!req.expectRevert) throw err;
      receipt = await ethers.provider.getTransactionReceipt(txResponse.hash);
    }
    if (!receipt) throw new Error(`[${meta.id}] no receipt for ${txResponse.hash}`);

    const status: number = receipt.status;
    if (req.expectRevert && status !== 0) {
      throw new Error(`[${meta.id}] expected revert but tx succeeded`);
    }
    if (!req.expectRevert && status !== 1) {
      throw new Error(`[${meta.id}] expected success but tx reverted`);
    }
    if (req.expectRevert && !revert) {
      revert = { kind: "unknown", data: null };
    }

    const events = status === 1 ? this.decodeEvents(receipt) : [];
    for (const e of events) {
      if (!e.decoded) {
        console.warn(`  [${meta.id}] WARNING: undecoded log ${e.logIndex} topic0=${e.topics[0]} from ${e.address}`);
      }
    }

    const postState = await this.snapshot([
      ...this.baseReads(req.balancesOf ?? []),
      ...(req.preReads ?? []),
      ...(req.postReads ?? []),
    ]);

    const vector = {
      id: meta.id,
      category: meta.category,
      description: meta.description,
      specRefs: meta.specRefs ?? [],
      proofsBypassed: meta.proofsBypassed ?? false,
      dependsOn: meta.dependsOn ?? [],
      setup: meta.setup ?? [],
      requiresImpersonation: meta.requiresImpersonation ?? null,
      setupTxs: (req.setupTxs ?? []).map((s) => ({
        from: s.fromLabel,
        to: s.toLabel,
        toAddress: s.to,
        calldata: s.calldata,
        description: s.description,
      })),
      tx: {
        from: req.fromLabel,
        fromAddress: await req.from.getAddress(),
        to: req.toLabel,
        toAddress: req.to,
        calldata: req.calldata,
        value: "0x0",
        decodedCall: req.decodedCall ? normalize(req.decodedCall) : null,
      },
      preState,
      result: {
        status,
        txHash: txResponse.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: toHex(receipt.gasUsed),
        returnData: returnData && returnData !== "0x" ? returnData : null,
        revert: req.expectRevert ? revert : null,
        events,
      },
      postState,
      context: {
        chainId: this.opts.chainId,
        network: "local fixturenet (Anvil, hub chain only)",
        deployments: this.opts.deployments,
        addressBook: this.opts.addressBook,
      },
      capturedAt: new Date().toISOString(),
    };

    const file = `${meta.id}.json`;
    writeJSON(path.join(this.opts.outDir, file), vector);

    this.entries.push({
      id: meta.id,
      file,
      category: meta.category,
      dependsOn: meta.dependsOn ?? [],
      proofsBypassed: meta.proofsBypassed ?? false,
      outcome: req.expectRevert ? "revert" : "success",
      revertReason: revert?.reason,
      description: meta.description,
    });

    const gasStr = Number(receipt.gasUsed).toLocaleString("en-US");
    const tag = req.expectRevert ? `REVERT ${revert?.reason ?? revert?.kind}` : "OK";
    console.log(`  [${meta.id}] ${tag} gas=${gasStr}`);
  }
}
