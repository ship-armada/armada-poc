// SPDX-License-Identifier: MIT
// ABOUTME: ABI-pinned type and constant surface for the Armada privacy pool system.
// ABOUTME: Field names, types, and ordering are consensus-critical; do not reorder or rename.
pragma solidity ^0.8.17;

// Order of the BN254 scalar field. Every field-valued public input must be
// strictly smaller than this value.
uint256 constant SNARK_SCALAR_FIELD =
    21888242871839275222246405745257275088548364400416034343698204186575808495617;

/// @notice Token standards the commitment format can describe. Only ERC20 is exercised
///         by the live shield/unshield paths; the other variants remain for ABI
///         compatibility.
enum TokenType {
    ERC20,
    ERC721,
    ERC1155
}

/// @notice How a transaction's unshield output is paid out.
///         NONE: no unshield; NORMAL: pay the recipient encoded in the note;
///         REDIRECT: the hash check binds the output to the submitting caller.
enum UnshieldType {
    NONE,
    NORMAL,
    REDIRECT
}

/// @notice A point on the BN254 curve over the base field (affine coordinates).
struct G1Point {
    uint256 x;
    uint256 y;
}

/// @notice A point on the BN254 twist over the quadratic extension field, stored as
///         coefficient pairs for each coordinate.
struct G2Point {
    uint256[2] x;
    uint256[2] y;
}

/// @notice A Groth16 proof: two G1 elements and one G2 element.
struct SnarkProof {
    G1Point a;
    G2Point b;
    G1Point c;
}

/// @notice A Groth16 verifying key for one circuit shape.
/// @param artifactsIPFSHash Informational pointer to circuit artifacts; unused by verification
/// @param alpha1 Key element in G1
/// @param beta2 Key element in G2
/// @param gamma2 Key element in G2
/// @param delta2 Key element in G2
/// @param ic Input-commitment points in G1; length must equal the number of public
///        inputs plus one
struct VerifyingKey {
    string artifactsIPFSHash;
    G1Point alpha1;
    G2Point beta2;
    G2Point gamma2;
    G2Point delta2;
    G1Point[] ic;
}

/// @notice Identifies the token a note is denominated in.
struct TokenData {
    TokenType tokenType;
    address tokenAddress;
    uint256 tokenSubID;
}

/// @notice The data committed into a Merkle leaf: owner key, token, and value.
/// @dev For unshield outputs, `npk` encodes the recipient address.
struct CommitmentPreimage {
    bytes32 npk;
    TokenData token;
    uint120 value;
}

/// @notice Encrypted note data broadcast alongside a shield so the recipient can
///         recover the note off-chain.
struct ShieldCiphertext {
    bytes32[3] encryptedBundle;
    bytes32 shieldKey;
}

/// @notice A single shield request: the commitment preimage plus its ciphertext.
struct ShieldRequest {
    CommitmentPreimage preimage;
    ShieldCiphertext ciphertext;
}

/// @notice Encrypted note data broadcast alongside a transaction commitment.
struct CommitmentCiphertext {
    bytes32[4] ciphertext;
    bytes32 blindedSenderViewingKey;
    bytes32 blindedReceiverViewingKey;
    bytes annotationData;
    bytes memo;
}

/// @notice Transaction fields bound into the proof's public inputs, constraining the
///         execution context (chain, tree, gas floor, optional adapt contract).
struct BoundParams {
    uint16 treeNumber;
    uint72 minGasPrice;
    UnshieldType unshield;
    uint64 chainID;
    address adaptContract;
    bytes32 adaptParams;
    CommitmentCiphertext[] commitmentCiphertext;
    // Owned path: the circuit's public owner input, zero for a non-owned
    // transaction. The router binds it as a public input of the owned proof
    // (armada-circuits src/operations/TransactOwned.circom), and
    // transactOwned checks it against msg.sender.
    bytes32 ownerField;
    // Disclosed-preimage records (armada-lean ArmadaLean/Pool.lean
    // `Pool.Call.transact`/`transactOwned`'s `records : List (Term ×
    // CommitmentPreimage)`), index-aligned with `commitments`. Zero-length
    // when nothing is disclosed; otherwise one entry per commitment, every
    // field zero for an undisclosed output and populated for a disclosed
    // one. The pool hashes each non-zero entry and requires it to equal the
    // matching commitment (`recordsMatch`/`recordsComplete`) before it
    // writes the entry to `preimageOf` (`recordStep`/`recordPreimages`).
    CommitmentPreimage[] publicOutputs;
}

/// @notice The seven original bound-parameter fields, in their pre-owned-path order.
///         The owned path added `ownerField` to `BoundParams`, but the circuit's
///         `boundParamsHash` public input is still computed over only these seven
///         fields. `ownerField` is bound as its own public input of the owned
///         circuit (armada-circuits `src/main/main_1x2_owned.circom:6`).
///         `_boundParamsHash` builds this struct and hashes it, so a real proof's
///         `boundParamsHash` still matches on chain.
struct BoundParamsCore {
    uint16 treeNumber;
    uint72 minGasPrice;
    UnshieldType unshield;
    uint64 chainID;
    address adaptContract;
    bytes32 adaptParams;
    CommitmentCiphertext[] commitmentCiphertext;
}

/// @notice A privacy pool transaction: a proof, its public anchors, the spent
///         nullifiers, the new commitments, the bound parameters, and the optional
///         unshield output note.
/// @dev `ownedNpk` and `ownedTranscriptHash` carry the owned circuit's public
///      OUTPUTS (armada-circuits src/operations/TransactOwned.circom) from the
///      prover through calldata: `ownedNpk[i] = Poseidon(ownerField, randomIn[i])`
///      for each input note, and `ownedTranscriptHash` binds merkleRoot,
///      boundParamsHash, nullifiers and commitments in place of an EdDSA
///      signature. The contract does not compute either value; it only places
///      them in verifyOwned's public-inputs array, so a wrong value fails Groth16
///      verification rather than a Solidity check. Both are zero-length/zero and
///      unused on the plain path.
struct Transaction {
    SnarkProof proof;
    bytes32 merkleRoot;
    bytes32[] nullifiers;
    bytes32[] commitments;
    BoundParams boundParams;
    CommitmentPreimage unshieldPreimage;
    bytes32[] ownedNpk;
    bytes32 ownedTranscriptHash;
}
