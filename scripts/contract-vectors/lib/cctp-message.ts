/**
 * CCTP V2 message fabrication for the hub-side hook-handler vectors.
 *
 * Encodes messages byte-for-byte per contracts/cctp/ICCTPV2.sol (MessageV2 /
 * BurnMessageV2 offset tables) so the hub's MockMessageTransmitterV2 accepts
 * them via receiveMessage() and the CCTPHookRouter dispatches into
 * PrivacyPool.handleReceive{Finalized,Unfinalized}Message.
 *
 * This mirrors what a client-chain depositForBurnWithHook would emit in its
 * MessageSent event, without needing to boot the client chains.
 */

import { ethers } from "hardhat";

export interface BurnMessageParams {
  burnToken: string; // address
  mintRecipient: string; // address (the hub PrivacyPool)
  amount: bigint; // gross burn amount
  messageSender: string; // bytes32 (remote pool)
  maxFee: bigint;
  feeExecuted: bigint;
  expirationBlock: bigint;
  hookData: string; // bytes
}

export interface MessageV2Params {
  sourceDomain: number;
  destinationDomain: number;
  nonce: string; // bytes32
  sender: string; // bytes32 (remote token messenger)
  recipient: string; // bytes32 (local token messenger)
  destinationCaller: string; // bytes32 (0 = anyone)
  minFinalityThreshold: number;
  finalityThresholdExecuted: number;
  messageBody: string; // bytes (BurnMessageV2)
}

function u32be(v: number): string {
  return ethers.toBeHex(v, 4);
}
function u256be(v: bigint): string {
  return ethers.toBeHex(v, 32);
}
function b32addr(a: string): string {
  return ethers.zeroPadValue(a, 32);
}

/** BurnMessageV2.encode — version(4) + 7x32-byte words + hookData. */
export function encodeBurnMessageV2(p: BurnMessageParams): string {
  return ethers.concat([
    u32be(1), // BURN_MESSAGE_VERSION
    b32addr(p.burnToken),
    b32addr(p.mintRecipient),
    u256be(p.amount),
    p.messageSender,
    u256be(p.maxFee),
    u256be(p.feeExecuted),
    u256be(p.expirationBlock),
    p.hookData,
  ]);
}

/** MessageV2 envelope — fixed 148-byte header + body. */
export function encodeMessageV2(p: MessageV2Params): string {
  return ethers.concat([
    u32be(1), // MESSAGE_VERSION
    u32be(p.sourceDomain),
    u32be(p.destinationDomain),
    p.nonce,
    p.sender,
    p.recipient,
    p.destinationCaller,
    u32be(p.minFinalityThreshold),
    u32be(p.finalityThresholdExecuted),
    p.messageBody,
  ]);
}

export interface ShieldDataFields {
  npk: string; // bytes32
  value: bigint; // uint120 gross declared value
  encryptedBundle: [string, string, string];
  shieldKey: string; // bytes32
  integrator: string; // address
}

/**
 * CCTPPayload hookData: abi.encode(CCTPPayload(SHIELD, abi.encode(ShieldData)))
 * — matches CCTPPayloadLib.encodeShield / decode in contracts/privacy-pool/types/CCTPTypes.sol.
 */
export function encodeShieldHookData(d: ShieldDataFields): string {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const shieldData = coder.encode(
    ["tuple(bytes32 npk, uint120 value, bytes32[3] encryptedBundle, bytes32 shieldKey, address integrator)"],
    [[d.npk, d.value, d.encryptedBundle, d.shieldKey, d.integrator]]
  );
  return coder.encode(["tuple(uint8 messageType, bytes data)"], [[0, shieldData]]);
}

/** CCTPPayload hookData with messageType = UNSHIELD (invalid inbound on hub). */
export function encodeUnshieldHookData(recipient: string): string {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const unshieldData = coder.encode(["tuple(address recipient)"], [[recipient]]);
  return coder.encode(["tuple(uint8 messageType, bytes data)"], [[1, unshieldData]]);
}
