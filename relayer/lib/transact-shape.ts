/**
 * ABI fragments + selector constants for the Railgun `transact` family of calls.
 *
 * The relayer's verifier handles two flavours of calldata:
 *   1. Vanilla `transact(Transaction[])` — the SDK's calldata decoder accepts this directly.
 *   2. Wrapper functions that EMBED a single Transaction struct as their first argument
 *      (`lendAndShield`, `atomicCrossChainUnshield`) whose broadcaster fee is an OUTPUT inside that
 *      Transaction. (`redeemAndShield` also embeds a Transaction, but its fee is contract-side —
 *      issue #312 — so it is verified separately by `redeem-fee-verifier.ts`, not this path.)
 *      The SDK's decoder is hard-coded to two function names and doesn't know our wrappers, so
 *      we decode them ourselves, lift the embedded Transaction, and re-encode it as a synthetic
 *      `transact([transaction])` call against the PrivacyPool address — same shape, same
 *      decryption pipeline as the vanilla path.
 *
 * Keeping the ABI strings here (not inline at the verifier) makes the supported-selectors set
 * the single review surface when a new wrapper is added. To extend in A5: add the selector +
 * its full function signature to the lists below; no other file needs to change.
 *
 * The Transaction struct shape MUST stay in sync with `contracts/railgun/logic/Globals.sol`.
 * If those structs change, the ABI strings below need to change too — and ethers will throw a
 * decoder error at the first mismatched call, which is the right failure mode.
 */

// ============ Selectors ============

/** PrivacyPool.transact(Transaction[]) — vanilla. */
export const TRANSACT_SELECTOR = "0xd8ae136a";

/** ArmadaYieldAdapter.lendAndShield(Transaction, bytes32, ShieldCiphertext) — yield deposit. */
export const LEND_AND_SHIELD_SELECTOR = "0xf2987ad1";

/**
 * ArmadaYieldAdapter.redeemAndShield(Transaction, bytes32, ShieldCiphertext, bytes32, ShieldCiphertext,
 * uint256) — yield withdraw. The fee is paid contract-side from the redeemed proceeds (issue #312),
 * shielded to the relayer's own 0zk note via `_feeNpk`/`_feeShieldCiphertext`/`_feeAmount`. It is NOT a
 * broadcaster output inside the embedded Transaction, so redeem is verified by `redeem-fee-verifier.ts`
 * (npk + amount), NOT the broadcaster-output path — hence it is absent from WRAPPER_SELECTORS /
 * WRAPPER_ABIS below and carries its own `REDEEM_AND_SHIELD_ABI`.
 */
export const REDEEM_AND_SHIELD_SELECTOR = "0x7e220759";

/**
 * PrivacyPool.atomicCrossChainUnshield(Transaction, uint32, address, uint256, bytes32) — A5
 * cross-chain unshield. The Transaction struct burns shielded USDC into the pool's own EOA and the
 * surrounding wrapper args drive the CCTP burn-and-mint to a different chain. Same
 * single-Transaction-in-arg-0 shape as the yield wrappers, so the synthetic-transact rewrite applies
 * here too. The CCTP destinationCaller is pinned on-chain (issue #64); the trailing bytes32 is an
 * opaque uniqueNonce for off-chain delivery matching (issue #287).
 */
export const ATOMIC_CROSS_CHAIN_UNSHIELD_SELECTOR = "0x2bcba06a";

/**
 * The wrappers that carry a broadcaster-fee OUTPUT inside their embedded Transaction and so need
 * synthetic-transact re-encoding before the SDK helper can decode. `redeemAndShield` is deliberately
 * NOT here — its fee is contract-side (issue #312) and verified by `redeem-fee-verifier.ts`.
 */
export const WRAPPER_SELECTORS: ReadonlySet<string> = new Set([
  LEND_AND_SHIELD_SELECTOR,
  ATOMIC_CROSS_CHAIN_UNSHIELD_SELECTOR,
]);

// ============ Shared struct fragments ============

/**
 * Railgun Transaction struct ABI. Matches `contracts/railgun/logic/Globals.sol::Transaction`.
 * Used both for the vanilla `transact(Transaction[])` and as the inner type carried by the
 * wrapper functions. The order MUST match the Solidity definition exactly — ethers decodes by
 * position, not by name.
 */
const TRANSACTION_STRUCT =
  "tuple(" +
  "tuple(" +
  "tuple(uint256 x, uint256 y) a," +
  "tuple(uint256[2] x, uint256[2] y) b," +
  "tuple(uint256 x, uint256 y) c" +
  ") proof," +
  "bytes32 merkleRoot," +
  "bytes32[] nullifiers," +
  "bytes32[] commitments," +
  "tuple(" +
  "uint16 treeNumber," +
  "uint72 minGasPrice," +
  "uint8 unshield," +
  "uint64 chainID," +
  "address adaptContract," +
  "bytes32 adaptParams," +
  "tuple(" +
  "bytes32[4] ciphertext," +
  "bytes32 blindedSenderViewingKey," +
  "bytes32 blindedReceiverViewingKey," +
  "bytes annotationData," +
  "bytes memo" +
  ")[] commitmentCiphertext" +
  ") boundParams," +
  "tuple(" +
  "bytes32 npk," +
  "tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token," +
  "uint120 value" +
  ") unshieldPreimage" +
  ")";

const SHIELD_CIPHERTEXT_STRUCT = "tuple(bytes32[3] encryptedBundle, bytes32 shieldKey)";

// ============ Function ABIs ============

/** Vanilla PrivacyPool.transact — used both for verification of incoming requests AND for
 *  encoding synthetic calldata when normalising wrapper calls. */
export const TRANSACT_ABI: readonly string[] = [
  `function transact(${TRANSACTION_STRUCT}[] _transactions)`,
];

/** Wrapper functions that carry a single Transaction in arg 0. The other args are passed
 *  through but the verifier doesn't inspect them — only the embedded Transaction matters for
 *  fee-payment verification. */
export const WRAPPER_ABIS: readonly string[] = [
  `function lendAndShield(${TRANSACTION_STRUCT} _transaction, bytes32 _npk, ${SHIELD_CIPHERTEXT_STRUCT} _shieldCiphertext)`,
  `function atomicCrossChainUnshield(${TRANSACTION_STRUCT} _transaction, uint32 destinationDomain, address finalRecipient, uint256 maxFee, bytes32 uniqueNonce)`,
];

/**
 * Full redeemAndShield ABI (6-arg, fee-bearing — issue #312). Used by `redeem-fee-verifier.ts` to
 * decode `_feeNpk` (arg 3) and `_feeAmount` (arg 5) — the fee destination + amount the relayer must
 * verify pay it. The embedded struct fragments MUST stay in sync with the contract (see file header).
 */
export const REDEEM_AND_SHIELD_ABI: readonly string[] = [
  `function redeemAndShield(${TRANSACTION_STRUCT} _transaction, bytes32 _npk, ${SHIELD_CIPHERTEXT_STRUCT} _shieldCiphertext, bytes32 _feeNpk, ${SHIELD_CIPHERTEXT_STRUCT} _feeShieldCiphertext, uint256 _feeAmount)`,
];
