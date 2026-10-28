// ABOUTME: The client rejects shield notes the hub would reject, before any USDC is burned (#607).
// ABOUTME: Covers crossChainShield, crossChainShieldWithFee, and the gasless wrapper that routes through it.
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/privacy-pool/PrivacyPoolClient.sol";
import {SNARK_SCALAR_FIELD} from "../contracts/privacy-pool/types/PoolTypes.sol";
import "../contracts/GaslessShieldWrapperClient.sol";
import "../contracts/cctp/MockUSDCV2.sol";
import "../contracts/cctp/MockCCTPV2.sol";

/// @dev WHY (whole file): a cross-chain shield burns the user's USDC on the client, and since #64 the
///      message can only be delivered through the hub's hook router. A note the hub rejects (zero
///      value, or an npk outside the SNARK field) makes that delivery revert on every attempt, so
///      the burned USDC is lost. The client must reject such notes before burning anything.
contract PrivacyPoolClientNoteValidationTest is Test {
    uint32 internal constant CLIENT_DOMAIN = 1;
    uint32 internal constant HUB_DOMAIN = 0;

    MockUSDCV2 internal usdc;
    PrivacyPoolClient internal client;
    GaslessShieldWrapperClient internal wrapper;

    uint256 internal userPk = 0xA11CE;
    address internal user;

    bytes32 internal constant VALID_NPK = bytes32(uint256(0xBEEF));
    bytes32 internal constant NPK_AT_FIELD = bytes32(SNARK_SCALAR_FIELD);

    function setUp() public {
        usdc = new MockUSDCV2("USD Coin", "USDC");
        MockMessageTransmitterV2 transmitter = new MockMessageTransmitterV2(CLIENT_DOMAIN, address(this));
        MockTokenMessengerV2 messenger = new MockTokenMessengerV2(address(transmitter), address(usdc), CLIENT_DOMAIN);
        transmitter.setTokenMessenger(address(messenger));

        client = new PrivacyPoolClient();
        client.initialize(
            address(messenger),
            address(transmitter),
            address(usdc),
            CLIENT_DOMAIN,
            HUB_DOMAIN,
            bytes32(uint256(0xB0B0)), // hub pool
            address(this)
        );
        client.setHubHookRouter(bytes32(uint256(0x4007)));
        wrapper = new GaslessShieldWrapperClient(address(usdc), address(client));

        user = vm.addr(userPk);
        usdc.mint(user, 1_000e6);
        vm.prank(user);
        usdc.approve(address(client), type(uint256).max);
    }

    function _note(bytes32 npk, uint256 value) internal pure returns (ShieldData memory) {
        return ShieldData({
            npk: npk,
            value: uint120(value),
            encryptedBundle: [bytes32(0), bytes32(0), bytes32(0)],
            shieldKey: bytes32(0),
            integrator: address(0)
        });
    }

    function _crossChainShield(bytes32 npk) internal {
        vm.prank(user);
        client.crossChainShield(100e6, 0, 2000, npk, [bytes32(0), bytes32(0), bytes32(0)], bytes32(0), address(0));
    }

    function _withFee(ShieldData memory userNote, ShieldData memory feeNote) internal {
        vm.prank(user);
        client.crossChainShieldWithFee(0, 2000, userNote, feeNote);
    }

    // ── crossChainShield ────────────────────────────────────────────────────

    /// @notice WHY: the largest valid npk must still be accepted (boundary of the check).
    function test_crossChainShield_acceptsLargestValidNpk() public {
        uint256 supplyBefore = usdc.totalSupply();
        _crossChainShield(bytes32(SNARK_SCALAR_FIELD - 1));
        assertEq(usdc.totalSupply(), supplyBefore - 100e6, "burned");
    }

    function test_crossChainShield_rejectsNpkAtField() public {
        vm.expectRevert("PrivacyPoolClient: Invalid npk");
        _crossChainShield(NPK_AT_FIELD);
    }

    function test_crossChainShield_rejectsNpkAboveField() public {
        vm.expectRevert("PrivacyPoolClient: Invalid npk");
        _crossChainShield(bytes32(type(uint256).max));
    }

    // ── crossChainShieldWithFee ─────────────────────────────────────────────

    function test_withFee_rejectsInvalidUserNpk() public {
        vm.expectRevert("PrivacyPoolClient: Invalid npk");
        _withFee(_note(NPK_AT_FIELD, 100e6), _note(VALID_NPK, 1e6));
    }

    function test_withFee_rejectsInvalidFeeNpk() public {
        vm.expectRevert("PrivacyPoolClient: Invalid npk");
        _withFee(_note(VALID_NPK, 100e6), _note(NPK_AT_FIELD, 1e6));
    }

    /// @notice WHY: a zero-value fee note was accepted here but rejected by the hub. A relayer could
    ///         hand a user such a fee note to sign (#607). Shields with no fee use crossChainShield.
    function test_withFee_rejectsZeroValueFeeNote() public {
        vm.expectRevert("PrivacyPoolClient: Invalid value");
        _withFee(_note(VALID_NPK, 100e6), _note(VALID_NPK, 0));
    }

    function test_withFee_acceptsValidNotes() public {
        uint256 supplyBefore = usdc.totalSupply();
        _withFee(_note(VALID_NPK, 100e6), _note(VALID_NPK, 1e6));
        assertEq(usdc.totalSupply(), supplyBefore - 101e6, "burned");
    }

    // ── Gasless wrapper (routes through crossChainShieldWithFee) ────────────

    /// @notice WHY: the gasless path must get the same protection without its own copy of the check.
    function test_gasless_rejectsInvalidNpk() public {
        ShieldData memory userNote = _note(NPK_AT_FIELD, 100e6);
        ShieldData memory feeNote = _note(VALID_NPK, 1e6);
        uint256 deadline = block.timestamp + 1 hours;
        GaslessShieldWrapperClient.CrossChainIntentParams memory params = _params(deadline, 101e6);
        bytes memory sig = _signIntent(userNote, feeNote, deadline);

        vm.expectRevert("PrivacyPoolClient: Invalid npk");
        wrapper.gaslessCrossChainShield(params, sig, userNote, feeNote);
    }

    function _params(uint256 deadline, uint256 total)
        internal
        view
        returns (GaslessShieldWrapperClient.CrossChainIntentParams memory)
    {
        bytes32 permitHash = keccak256(abi.encode(
            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
            user, address(wrapper), total, usdc.nonces(user), deadline
        ));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(userPk, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), permitHash)));
        return GaslessShieldWrapperClient.CrossChainIntentParams({
            user: user, deadline: deadline, nonce: 0, maxFee: 0, minFinalityThreshold: 2000,
            permitV: v, permitR: r, permitS: s
        });
    }

    function _signIntent(ShieldData memory userNote, ShieldData memory feeNote, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(
            wrapper.CROSS_CHAIN_SHIELD_INTENT_TYPEHASH(),
            user,
            keccak256(abi.encode(userNote)),
            keccak256(abi.encode(feeNote)),
            uint256(0),   // maxFee
            uint32(2000), // minFinalityThreshold
            deadline,
            uint256(0)    // nonce
        ));
        bytes32 domain = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes("ArmadaGaslessCrossChainShield")),
            keccak256(bytes("1")),
            block.chainid,
            address(wrapper)
        ));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }
}
