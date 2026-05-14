// ABOUTME: Foundry deployment harness for Orca fuzzing of the Armada crowdfund.
// ABOUTME: Deploys MockUSDC + real ArmadaToken + ArmadaCrowdfund, pre-funds 9 well-known EOAs.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import {Script} from "forge-std/Script.sol";

import {MockUSDCV2} from "contracts/cctp/MockUSDCV2.sol";
import {ArmadaToken} from "contracts/governance/ArmadaToken.sol";
import {ArmadaCrowdfund} from "contracts/crowdfund/ArmadaCrowdfund.sol";

/// @notice Orca harness: deploys the crowdfund and pre-funds 9 well-known EOAs
///         (vm.addr(1)..vm.addr(9)) so the fuzzer can drive commit/invite paths
///         after warping into the active window.
///
///         Post-deploy state:
///         - Phase.Active, armLoaded == true
///         - block.timestamp < windowStart (fuzzer warps to enter the window)
///         - No seeds yet (fuzzer pranks as launchTeam to call addSeed)
///         - 9 actor EOAs each hold 200k mock-USDC with infinite allowance
///           to the crowdfund
///
///         Expected fuzzer entry points:
///           - addSeed / addSeeds / launchTeamInvite (as DEPLOYER)
///           - invite / commit / commitWithInvite / revokeInviteNonce (as actors)
///           - finalize / claim / claimRefund / withdrawUnallocatedArm (anyone)
///           - cancel (as SECURITY_COUNCIL)
///
///         Time control is left to the fuzzer's vm.warp — broadcasted vm.warp
///         in the deploy script does not propagate to anvil's block timestamps
///         under forge script --broadcast.
contract OrCaCrowdfundDeploy is Script {
    // ---------- Well-known Anvil account #0 (public knowledge) ----------
    // Anvil default key, safe to hardcode per project policy (see CLAUDE.md
    // "Never commit private keys" exception and scripts/check-secrets.sh
    // ALLOWED_FILES). Using the private-key form so actor approvals (which
    // also use private keys 1..9) follow the same broadcast pattern.
    address private constant DEPLOYER = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    uint256 private constant DEPLOYER_KEY =
        0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    // ---------- Role sentinels ----------
    // Distinct, high-bit addresses chosen to be easy to recognize in fuzzer
    // traces and to avoid any collision with precompiles (>=0x1000).
    address public constant TREASURY = address(0x1001);
    address public constant SECURITY_COUNCIL = address(0x1002);
    address public constant TIMELOCK = address(0x1003);
    address public constant WINDDOWN = address(0x1004);

    // ---------- Crowdfund parameters ----------
    // OPEN_OFFSET sized to comfortably beat any race between forge-script
    // simulation time and anvil block-mining time during broadcast prep.
    uint256 private constant OPEN_OFFSET = 1 hours;
    uint256 private constant USER_USDC_FUND = 200_000 * 1e6; // 200k USDC per EOA

    // 9 actors derived from low-integer private keys (vm.addr(1)..vm.addr(9)).
    // These are the addresses fuzzers most commonly enumerate as test senders,
    // so seeding them with USDC + approval maximises the chance the fuzzer
    // reaches commit/commitWithInvite quickly.
    uint256 private constant ACTOR_COUNT = 9;

    // ---------- Deployed contracts (public so specs can dereference them) ----------
    MockUSDCV2 public usdc;
    ArmadaToken public armToken;
    ArmadaCrowdfund public crowdfund;

    // ---------- Actor address book (set during run) ----------
    address[ACTOR_COUNT] public actors;

    function run() external {
        for (uint256 i = 0; i < ACTOR_COUNT; i++) {
            actors[i] = vm.addr(i + 1); // skip key 0 (invalid)
        }

        // ===== Phase 1: deployer broadcast — deploy + wire + fund =====
        vm.startBroadcast(DEPLOYER_KEY);

        usdc = new MockUSDCV2("USD Coin", "USDC");
        armToken = new ArmadaToken(DEPLOYER, TIMELOCK);

        uint256 openTimestamp = block.timestamp + OPEN_OFFSET;
        crowdfund = new ArmadaCrowdfund(
            address(usdc),
            address(armToken),
            TREASURY,
            DEPLOYER, // launchTeam
            SECURITY_COUNCIL,
            openTimestamp
        );

        // ARM token one-shot init (mirrors prod deploy_crowdfund order)
        address[] memory whitelist = new address[](3);
        whitelist[0] = address(crowdfund);
        whitelist[1] = TREASURY;
        whitelist[2] = DEPLOYER;
        armToken.initWhitelist(whitelist);

        address[] memory delegators = new address[](1);
        delegators[0] = address(crowdfund);
        armToken.initAuthorizedDelegators(delegators);

        address[] memory noDelegate = new address[](1);
        noDelegate[0] = TREASURY;
        armToken.initNoDelegation(noDelegate);

        armToken.setWindDownContract(WINDDOWN);

        // Fund crowdfund with enough ARM for MAX_SALE
        uint256 armForMaxSale = (crowdfund.MAX_SALE() * 1e18) / crowdfund.ARM_PRICE();
        armToken.transfer(address(crowdfund), armForMaxSale);

        armToken.removeDeployerFromWhitelist();

        // Mint USDC + fund ETH to every actor. The ETH stipend lets each actor
        // pay gas for the upcoming approve broadcast (and any fuzzer-driven
        // txs after). vm.deal would not propagate to anvil under --broadcast,
        // so use a real value-bearing call from the deployer.
        for (uint256 i = 0; i < ACTOR_COUNT; i++) {
            usdc.mint(actors[i], USER_USDC_FUND);
            (bool ok, ) = actors[i].call{value: 1 ether}("");
            require(ok, "OrCa harness: ETH stipend transfer failed");
        }

        // Verify ARM pre-load (no phase/window check; just verifies balance)
        crowdfund.loadArm();

        vm.stopBroadcast();

        // ===== Phase 2: per-actor approvals (must be broadcast as the actor) =====
        // Cheatcode-only approvals (vm.prank + approve outside broadcast) would
        // not be replayed to Orca's chain, so each approval rides its own broadcast.
        for (uint256 i = 0; i < ACTOR_COUNT; i++) {
            vm.startBroadcast(i + 1); // private key = i + 1
            usdc.approve(address(crowdfund), type(uint256).max);
            vm.stopBroadcast();
        }
    }
}
