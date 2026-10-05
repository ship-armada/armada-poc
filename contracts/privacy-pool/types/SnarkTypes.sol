// SPDX-License-Identifier: MIT
// ABOUTME: Groth16 proof verification over BN254 using the ecAdd/ecMul/ecPairing precompiles.
// ABOUTME: Curve arithmetic re-derived from the MIT-licensed EigenLayer BN254 library
// ABOUTME: lineage (itself adapted from the MIT-licensed solcrypto altbn128 library).
pragma solidity ^0.8.17;

import { G1Point, G2Point, VerifyingKey, SnarkProof, SNARK_SCALAR_FIELD } from "./PoolTypes.sol";

/// @title Snark
/// @notice Groth16 verifier for the privacy pool circuits. The verifying key is passed
///         in dynamically (one key per circuit shape), so a single implementation serves
///         every registered (nullifiers, commitments) configuration.
library Snark {
    /// @notice Modulus of the BN254 base field F_q (the field the curve's coordinates
    ///         live in). Distinct from the scalar field order.
    uint256 internal constant PRIME_Q =
        21888242871839275222246405745257275088696311157297823662689037894645226208583;

    /// @notice Verify a Groth16 proof against a verifying key and public inputs.
    /// @dev Computes vkX = ic[0] + sum(inputs[i] * ic[i+1]) and then checks the pairing
    ///      product e(-a, b) * e(alpha1, beta2) * e(vkX, gamma2) * e(c, delta2) == 1.
    /// @param verifyingKey The key registered for the circuit shape being proven
    /// @param proof The Groth16 proof
    /// @param inputs The public inputs; each must be a canonical scalar-field element
    /// @return True iff the pairing equation holds
    function verify(
        VerifyingKey memory verifyingKey,
        SnarkProof memory proof,
        uint256[] memory inputs
    ) internal view returns (bool) {
        require(
            verifyingKey.ic.length == inputs.length + 1,
            "Snark: IC length does not match input count"
        );

        G1Point memory vkX = verifyingKey.ic[0];

        for (uint256 i = 0; i < inputs.length; i++) {
            require(inputs[i] < SNARK_SCALAR_FIELD, "Snark: Input > SNARK_SCALAR_FIELD");
            vkX = plus(vkX, scalarMul(verifyingKey.ic[i + 1], inputs[i]));
        }

        return pairing(
            negate(proof.a),
            proof.b,
            verifyingKey.alpha1,
            verifyingKey.beta2,
            vkX,
            verifyingKey.gamma2,
            proof.c,
            verifyingKey.delta2
        );
    }

    /// @notice Negate a G1 point.
    /// @dev Validates that the point is on the curve y^2 = x^3 + 3 over F_q before
    ///      negating; the point at infinity is represented by (0, 0) and negates to
    ///      itself.
    function negate(G1Point memory point) internal pure returns (G1Point memory) {
        if (point.x == 0 && point.y == 0) {
            return G1Point(0, 0);
        }

        require(point.x < PRIME_Q && point.y < PRIME_Q, "Snark: Point outside base field");

        uint256 ySquared = mulmod(point.y, point.y, PRIME_Q);
        uint256 xCubedPlusB = addmod(
            mulmod(mulmod(point.x, point.x, PRIME_Q), point.x, PRIME_Q),
            3,
            PRIME_Q
        );
        require(ySquared == xCubedPlusB, "Snark: Point not on curve");

        return G1Point(point.x, PRIME_Q - point.y);
    }

    /// @notice Multiply a G1 point by a scalar via the ecMul precompile (0x07).
    function scalarMul(
        G1Point memory point,
        uint256 scalar
    ) internal view returns (G1Point memory result) {
        uint256[3] memory input;
        input[0] = point.x;
        input[1] = point.y;
        input[2] = scalar;

        bool success;
        assembly {
            success := staticcall(sub(gas(), 2000), 7, input, 0x60, result, 0x40)
        }
        require(success, "Snark: ecMul failed");
    }

    /// @notice Add two G1 points via the ecAdd precompile (0x06).
    function plus(
        G1Point memory p1,
        G1Point memory p2
    ) internal view returns (G1Point memory result) {
        uint256[4] memory input;
        input[0] = p1.x;
        input[1] = p1.y;
        input[2] = p2.x;
        input[3] = p2.y;

        bool success;
        assembly {
            success := staticcall(sub(gas(), 2000), 6, input, 0x80, result, 0x40)
        }
        require(success, "Snark: ecAdd failed");
    }

    /// @notice Evaluate a four-pairing product check via the ecPairing precompile
    ///         (0x08): returns true iff e(a1, a2) * e(b1, b2) * e(c1, c2) * e(d1, d2)
    ///         equals the multiplicative identity.
    function pairing(
        G1Point memory a1,
        G2Point memory a2,
        G1Point memory b1,
        G2Point memory b2,
        G1Point memory c1,
        G2Point memory c2,
        G1Point memory d1,
        G2Point memory d2
    ) internal view returns (bool) {
        G1Point[4] memory g1Points;
        G2Point[4] memory g2Points;
        g1Points[0] = a1;
        g1Points[1] = b1;
        g1Points[2] = c1;
        g1Points[3] = d1;
        g2Points[0] = a2;
        g2Points[1] = b2;
        g2Points[2] = c2;
        g2Points[3] = d2;

        uint256[24] memory input;
        for (uint256 i = 0; i < 4; i++) {
            uint256 offset = i * 6;
            input[offset] = g1Points[i].x;
            input[offset + 1] = g1Points[i].y;
            input[offset + 2] = g2Points[i].x[0];
            input[offset + 3] = g2Points[i].x[1];
            input[offset + 4] = g2Points[i].y[0];
            input[offset + 5] = g2Points[i].y[1];
        }

        uint256[1] memory out;
        bool success;
        assembly {
            success := staticcall(sub(gas(), 2000), 8, input, 0x300, out, 0x20)
        }
        require(success, "Snark: pairing precompile failed");

        return out[0] != 0;
    }
}
