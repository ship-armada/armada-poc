// SPDX-License-Identifier: MIT
// ABOUTME: Foundry tests verifying ArmadaYieldAdapter enforces governance adapter registry checks.
// ABOUTME: Tests that lendAndShield requires authorized, redeemAndShield allows withdraw-only.
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/yield/ArmadaYieldAdapter.sol";
import "../contracts/governance/MockAdapterRegistry.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Minimal ERC20 for testing (vault stand-in)
contract SimpleToken is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @title AdapterRegistryEnforcementTest — Verifies adapter enforces registry authorization
/// @notice The authorization check fires before any proof/pool logic, so we can test
///         enforcement in isolation using dummy transaction data.
contract AdapterRegistryEnforcementTest is Test {

    MockAdapterRegistry public registry;
    ArmadaYieldAdapter public adapter;
    SimpleToken public usdc;
    SimpleToken public vault;

    function setUp() public {
        usdc = new SimpleToken("USDC", "USDC");
        vault = new SimpleToken("Vault", "ayUSDC");
        registry = new MockAdapterRegistry();

        adapter = new ArmadaYieldAdapter(
            address(usdc),
            address(vault),
            address(registry)
        );
    }

    // ======== Helper: build minimal dummy transaction data ========

    function _dummyTransaction() internal view returns (Transaction memory) {
        Transaction memory tx_;
        tx_.boundParams.adaptContract = address(adapter);
        return tx_;
    }

    function _dummyCiphertext() internal pure returns (ShieldCiphertext memory) {
        ShieldCiphertext memory ct;
        return ct;
    }

    // ======== lendAndShield enforcement ========

    function test_lendAndShield_revertsWhenNotAuthorized() public {
        // Registry: adapter is NOT authorized (default false)
        vm.expectRevert("ArmadaYieldAdapter: not authorized");
        adapter.lendAndShield(_dummyTransaction(), bytes32(0), _dummyCiphertext());
    }

    function test_lendAndShield_revertsWhenWithdrawOnly() public {
        // Registry: adapter is withdraw-only but NOT fully authorized
        registry.setWithdrawOnly(address(adapter), true);

        vm.expectRevert("ArmadaYieldAdapter: not authorized");
        adapter.lendAndShield(_dummyTransaction(), bytes32(0), _dummyCiphertext());
    }

    function test_lendAndShield_passesAuthCheckWhenAuthorized() public {
        // Registry: adapter IS authorized
        registry.setAuthorized(address(adapter), true);

        // Should pass the auth check but revert later (no privacy pool set)
        vm.expectRevert("ArmadaYieldAdapter: no privacyPool");
        adapter.lendAndShield(_dummyTransaction(), bytes32(0), _dummyCiphertext());
    }

    // ======== redeemAndShield enforcement ========

    function test_redeemAndShield_revertsWhenNotAuthorized() public {
        // Registry: adapter is NOT authorized and NOT withdraw-only
        vm.expectRevert("ArmadaYieldAdapter: not authorized or withdraw-only");
        adapter.redeemAndShield(_dummyTransaction(), bytes32(0), _dummyCiphertext());
    }

    function test_redeemAndShield_passesAuthCheckWhenAuthorized() public {
        // Registry: adapter IS authorized
        registry.setAuthorized(address(adapter), true);

        // Should pass auth check but revert later (no privacy pool)
        vm.expectRevert("ArmadaYieldAdapter: no privacyPool");
        adapter.redeemAndShield(_dummyTransaction(), bytes32(0), _dummyCiphertext());
    }

    function test_redeemAndShield_passesAuthCheckWhenWithdrawOnly() public {
        // Registry: adapter is withdraw-only (not fully authorized)
        registry.setWithdrawOnly(address(adapter), true);

        // Should pass auth check but revert later (no privacy pool)
        vm.expectRevert("ArmadaYieldAdapter: no privacyPool");
        adapter.redeemAndShield(_dummyTransaction(), bytes32(0), _dummyCiphertext());
    }

    // ======== Constructor validation ========

    function test_constructor_revertsOnZeroGovernor() public {
        vm.expectRevert("ArmadaYieldAdapter: zero governor");
        new ArmadaYieldAdapter(address(usdc), address(vault), address(0));
    }

    function test_constructor_setsAdapterRegistry() public {
        assertEq(address(adapter.adapterRegistry()), address(registry));
    }

    // ======== Full lifecycle with registry state changes ========

    function test_lifecycle_authThenDeauthBlocksLend() public {
        // Authorize
        registry.setAuthorized(address(adapter), true);
        // lendAndShield passes auth (reverts on privacyPool, meaning auth passed)
        vm.expectRevert("ArmadaYieldAdapter: no privacyPool");
        adapter.lendAndShield(_dummyTransaction(), bytes32(0), _dummyCiphertext());

        // Deauthorize (withdraw-only)
        registry.setAuthorized(address(adapter), false);
        registry.setWithdrawOnly(address(adapter), true);
        // lendAndShield now blocked at auth check
        vm.expectRevert("ArmadaYieldAdapter: not authorized");
        adapter.lendAndShield(_dummyTransaction(), bytes32(0), _dummyCiphertext());

        // redeemAndShield still works (passes auth, reverts on privacyPool)
        vm.expectRevert("ArmadaYieldAdapter: no privacyPool");
        adapter.redeemAndShield(_dummyTransaction(), bytes32(0), _dummyCiphertext());
    }

    function test_lifecycle_fullDeauthBlocksEverything() public {
        // Start fully deauthorized (both false)
        vm.expectRevert("ArmadaYieldAdapter: not authorized");
        adapter.lendAndShield(_dummyTransaction(), bytes32(0), _dummyCiphertext());

        vm.expectRevert("ArmadaYieldAdapter: not authorized or withdraw-only");
        adapter.redeemAndShield(_dummyTransaction(), bytes32(0), _dummyCiphertext());
    }
}
