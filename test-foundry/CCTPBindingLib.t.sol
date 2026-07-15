// ABOUTME: Tests CCTPBindingLib — the cross-chain unshield destination tuple (recipient, domain, maxFee)
// ABOUTME: is committed into adaptParams so a relayer/front-runner cannot redirect the exit (#364/#378).

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/privacy-pool/CCTPBindingLib.sol";

contract CCTPBindingLibTest is Test {
    address constant RECIPIENT = address(0xA11CE);
    uint32 constant DOMAIN = 6;
    uint256 constant MAX_FEE = 5_000_000;

    /// @dev WHY: the honest submission — exact committed args must verify.
    function test_verify_acceptsCommittedTuple() public {
        bytes32 ap = CCTPBindingLib.encode(RECIPIENT, DOMAIN, MAX_FEE);
        assertTrue(CCTPBindingLib.verify(ap, RECIPIENT, DOMAIN, MAX_FEE));
    }

    /// @dev WHY: core anti-theft property — a redirected recipient must fail.
    function test_verify_rejectsRedirectedRecipient() public {
        bytes32 ap = CCTPBindingLib.encode(RECIPIENT, DOMAIN, MAX_FEE);
        assertFalse(CCTPBindingLib.verify(ap, address(0xBAD), DOMAIN, MAX_FEE));
    }

    /// @dev WHY: a redirected destination domain (wrong-chain redirect) must fail.
    function test_verify_rejectsChangedDomain() public {
        bytes32 ap = CCTPBindingLib.encode(RECIPIENT, DOMAIN, MAX_FEE);
        assertFalse(CCTPBindingLib.verify(ap, RECIPIENT, DOMAIN + 1, MAX_FEE));
    }

    /// @dev WHY: an inflated maxFee (starve the payout via the CCTP fee) must fail.
    function test_verify_rejectsInflatedFee() public {
        bytes32 ap = CCTPBindingLib.encode(RECIPIENT, DOMAIN, MAX_FEE);
        assertFalse(CCTPBindingLib.verify(ap, RECIPIENT, DOMAIN, MAX_FEE * 2));
    }

    /// @dev WHY: a local unshield / plain transact carries adaptParams == 0, which must never satisfy
    ///      the binding — this is what blocks hijacking a local proof through the cross-chain path (#364).
    function test_verify_rejectsZeroAdaptParams() public {
        assertFalse(CCTPBindingLib.verify(bytes32(0), RECIPIENT, DOMAIN, MAX_FEE));
    }

    /// @dev WHY: the versioned DOMAIN_TAG must make the commitment distinct from a bare
    ///      keccak(recipient, domain, fee), so a future adaptParams format cannot collide with v1 (#378).
    function test_encode_isDomainSeparated() public {
        bytes32 tagged = CCTPBindingLib.encode(RECIPIENT, DOMAIN, MAX_FEE);
        bytes32 bare = keccak256(abi.encode(RECIPIENT, DOMAIN, MAX_FEE));
        assertTrue(tagged != bare, "encode must be domain-separated from a bare hash");
    }

    /// @dev WHY: fuzz the binding — ANY deviation in any field must fail verification.
    function testFuzz_verify_rejectsAnyDeviation(
        address recipient,
        uint32 domain,
        uint256 maxFee,
        address wRecipient,
        uint32 wDomain,
        uint256 wMaxFee
    ) public {
        vm.assume(recipient != wRecipient || domain != wDomain || maxFee != wMaxFee);
        bytes32 ap = CCTPBindingLib.encode(recipient, domain, maxFee);
        assertFalse(CCTPBindingLib.verify(ap, wRecipient, wDomain, wMaxFee));
    }
}
