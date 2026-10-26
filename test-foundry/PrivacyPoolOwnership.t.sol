// ABOUTME: Two-step ownership transfer for PrivacyPool and PrivacyPoolClient (#349).
// ABOUTME: The owner proposes a new owner, who must accept before any admin power moves.
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/privacy-pool/PrivacyPool.sol";
import "../contracts/privacy-pool/PrivacyPoolClient.sol";
import "../contracts/privacy-pool/modules/ShieldModule.sol";
import "../contracts/privacy-pool/modules/TransactModule.sol";
import "../contracts/privacy-pool/modules/MerkleModule.sol";
import "../contracts/privacy-pool/modules/VerifierModule.sol";
import "./helpers/PoseidonLinker.sol";

/// @dev Shared assertions, run against both contracts through this minimal surface.
interface IOwnable2Step {
    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function transferOwnership(address newOwner) external;
    function acceptOwnership() external;
}

abstract contract OwnershipTransferTests is Test {
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    address internal newOwner = address(0xB0B);
    address internal stranger = address(0x5157);

    /// @dev The contract under test, owned by this test contract.
    function _target() internal view virtual returns (IOwnable2Step);

    /// @dev Calls an owner-only setter as `caller`; returns whether it succeeded.
    function _callAdminSetter(address caller) internal virtual returns (bool);

    /// @dev Revert string prefix ("PrivacyPool" or "PrivacyPoolClient").
    function _prefix() internal pure virtual returns (string memory);

    /// @notice WHY: a one-step transfer to a mistyped address would lose the pool's admin keys
    ///         forever. Proposing must change nothing until the new owner accepts.
    function test_transferOwnershipOnlyProposes() public {
        IOwnable2Step t = _target();
        vm.expectEmit(true, true, false, false, address(t));
        emit OwnershipTransferStarted(address(this), newOwner);
        t.transferOwnership(newOwner);

        assertEq(t.owner(), address(this), "owner unchanged until accepted");
        assertEq(t.pendingOwner(), newOwner, "pending owner recorded");
        assertTrue(_callAdminSetter(address(this)), "current owner keeps admin rights");
        assertFalse(_callAdminSetter(newOwner), "pending owner has no admin rights yet");
    }

    /// @notice WHY: only the current owner may start a transfer.
    function test_transferOwnershipOnlyOwner() public {
        IOwnable2Step t = _target();
        vm.prank(stranger);
        vm.expectRevert(bytes(string.concat(_prefix(), ": Only owner")));
        t.transferOwnership(stranger);
    }

    /// @notice WHY: the accept step is what proves the new owner controls its key.
    function test_acceptOwnershipMovesAdminRights() public {
        IOwnable2Step t = _target();
        t.transferOwnership(newOwner);

        vm.expectEmit(true, true, false, false, address(t));
        emit OwnershipTransferred(address(this), newOwner);
        vm.prank(newOwner);
        t.acceptOwnership();

        assertEq(t.owner(), newOwner, "new owner");
        assertEq(t.pendingOwner(), address(0), "pending cleared");
        assertTrue(_callAdminSetter(newOwner), "new owner has admin rights");
        assertFalse(_callAdminSetter(address(this)), "old owner lost admin rights");
    }

    /// @notice WHY: nobody but the proposed owner can complete the transfer.
    function test_acceptOwnershipOnlyPendingOwner() public {
        IOwnable2Step t = _target();
        t.transferOwnership(newOwner);

        vm.prank(stranger);
        vm.expectRevert(bytes(string.concat(_prefix(), ": not pending owner")));
        t.acceptOwnership();
    }

    /// @notice WHY: with nothing pending, accept must fail for everyone (pendingOwner is zero and
    ///         no caller can be address(0)).
    function test_acceptOwnershipWithNothingPendingReverts() public {
        IOwnable2Step t = _target();
        vm.prank(newOwner);
        vm.expectRevert(bytes(string.concat(_prefix(), ": not pending owner")));
        t.acceptOwnership();
    }

    /// @notice WHY: a wrong proposal must be correctable. A new proposal replaces the old one, and
    ///         proposing address(0) cancels, so the replaced address can no longer accept.
    function test_proposalCanBeReplacedOrCancelled() public {
        IOwnable2Step t = _target();
        t.transferOwnership(stranger);
        t.transferOwnership(newOwner);
        vm.prank(stranger);
        vm.expectRevert(bytes(string.concat(_prefix(), ": not pending owner")));
        t.acceptOwnership();

        t.transferOwnership(address(0));
        assertEq(t.pendingOwner(), address(0), "proposal cancelled");
        vm.prank(newOwner);
        vm.expectRevert(bytes(string.concat(_prefix(), ": not pending owner")));
        t.acceptOwnership();
        assertEq(t.owner(), address(this), "owner unchanged");
    }
}

/// @title PrivacyPool ownership transfer
contract PrivacyPoolOwnershipTest is OwnershipTransferTests, PoseidonLinker {
    PrivacyPool internal pool;

    function setUp() public {
        _linkRealPoseidon();
        pool = new PrivacyPool();
        pool.initialize(
            address(new ShieldModule()),
            address(new TransactModule()),
            address(new MerkleModule()),
            address(new VerifierModule()),
            address(0x7E55),  // tokenMessenger (unused here)
            address(0x7A45),  // messageTransmitter (unused here)
            address(0x05DC),  // usdc (unused here)
            0,                // localDomain
            address(this),    // owner
            payable(address(0xFEE))
        );
    }

    function _target() internal view override returns (IOwnable2Step) {
        return IOwnable2Step(address(pool));
    }

    function _callAdminSetter(address caller) internal override returns (bool ok) {
        vm.prank(caller);
        (ok,) = address(pool).call(abi.encodeCall(PrivacyPool.setShieldFee, (uint120(10))));
    }

    function _prefix() internal pure override returns (string memory) {
        return "PrivacyPool";
    }

    /// @notice WHY: pendingOwner takes one slot from the reserved gap. The modules share this
    ///         storage through delegatecall, so every existing variable must keep its slot.
    function test_pendingOwnerDoesNotShiftExistingStorage() public {
        pool.transferOwnership(newOwner);
        // owner + initialized share slot 56; adapterRegistry is slot 62; pendingOwner is slot 63.
        assertEq(address(uint160(uint256(vm.load(address(pool), bytes32(uint256(56)))))), address(this), "owner slot");
        assertEq(address(uint160(uint256(vm.load(address(pool), bytes32(uint256(63)))))), newOwner, "pendingOwner slot");
    }
}

/// @title PrivacyPoolClient ownership transfer
contract PrivacyPoolClientOwnershipTest is OwnershipTransferTests {
    PrivacyPoolClient internal client;

    function setUp() public {
        client = new PrivacyPoolClient();
        client.initialize(
            address(0x7E55), // tokenMessenger (unused here)
            address(0x7A45), // messageTransmitter (unused here)
            address(0x05DC), // usdc (unused here)
            1,               // localDomain
            0,               // hubDomain
            bytes32(uint256(0xB0B0)), // hubPool
            address(this)    // owner
        );
    }

    function _target() internal view override returns (IOwnable2Step) {
        return IOwnable2Step(address(client));
    }

    function _callAdminSetter(address caller) internal override returns (bool ok) {
        vm.prank(caller);
        (ok,) = address(client).call(abi.encodeCall(PrivacyPoolClient.setDefaultFinalityThreshold, (uint32(1000))));
    }

    function _prefix() internal pure override returns (string memory) {
        return "PrivacyPoolClient";
    }
}
