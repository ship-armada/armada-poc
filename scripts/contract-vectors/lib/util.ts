/**
 * Shared utilities for the contract-vector capture harness.
 *
 * Determinism: every pseudo-random field element / bytes32 in the corpus is
 * derived as keccak256("armada-vector:" + seed) (optionally reduced mod the
 * BN254 scalar field), so re-running the capture against a fresh fixturenet
 * reproduces identical calldata except for deployment-dependent addresses.
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

export const SNARK_SCALAR_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Deterministic bytes32 from a human-readable seed. */
export function d32(seed: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(`armada-vector:${seed}`));
}

/** Deterministic field element (< SNARK_SCALAR_FIELD) as bytes32. */
export function d32Field(seed: string): string {
  const v = BigInt(d32(seed)) % SNARK_SCALAR_FIELD;
  return ethers.zeroPadValue(ethers.toBeHex(v), 32);
}

/** Deterministic npk (< SNARK_SCALAR_FIELD) as bytes32. */
export function npkFromSeed(seed: string): string {
  return d32Field(`npk:${seed}`);
}

export function toHex(n: bigint | string): string {
  if (typeof n === "string") return n;
  return "0x" + n.toString(16);
}

/** JSON replacer: bigint -> 0x-hex, so captured values diff cleanly. */
export function bigintReplacer(_key: string, value: any): any {
  return typeof value === "bigint" ? toHex(value) : value;
}

export function writeJSON(filePath: string, obj: any): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, bigintReplacer, 2) + "\n");
}

/** Normalize ethers Result/structs into plain JSON-safe objects. */
export function normalize(value: any): any {
  if (typeof value === "bigint") return toHex(value);
  if (value instanceof Uint8Array) return ethers.hexlify(value);
  if (Array.isArray(value)) {
    // ethers Result arrays with named fields: keep the named view. toObject()
    // throws on unnamed results (plain arrays, bytes32[N], etc.) — fall back
    // to positional mapping in that case.
    if (typeof (value as any).toObject === "function") {
      try {
        const obj = (value as any).toObject();
        const keys = Object.keys(obj);
        // Single-element unnamed Results serialize as { _: ... } — keep the
        // positional (array) form for those as well.
        if (keys.length > 0 && !(keys.length === 1 && keys[0] === "_")) {
          return normalize(obj);
        }
      } catch {
        // unnamed Result — positional form below
      }
    }
    return value.map(normalize);
  }
  if (value && typeof value === "object") {
    const out: Record<string, any> = {};
    for (const k of Object.keys(value)) {
      if (/^\d+$/.test(k)) continue; // skip numeric dupes from ethers Results
      out[k] = normalize(value[k]);
    }
    return out;
  }
  return value;
}
