// ABOUTME: Foundry tests for the queue-time treasury outflow feasibility check on ArmadaGovernor.
// ABOUTME: Rejects proposals whose aggregate per-token spend exceeds the current effective outflow limit.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/governance/ArmadaGovernor.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/governance/ArmadaTreasuryGov.sol";
import "../contracts/governance/TreasurySteward.sol";
import "../contracts/governance/IArmadaGovernance.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "./helpers/GovernorDeployHelper.sol";

/// @dev Minimal mock ERC20 with public mint for treasury funding.
contract QueueOutflowMockToken is ERC20 {
    uint8 private _dec;

    constructor(string memory name, string memory sym, uint8 dec) ERC20(name, sym) {
        _dec = dec;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @title GovernorQueueOutflowTest — queue-time outflow feasibility check (issue #235)
/// @notice Covers the 7 scenarios from issue #235: single-call infeasibility for distribute
///         and stewardSpend, temporarily-blocked passing case, batched aggregation, target
///         filtering, independent per-token aggregation, and mixed selector aggregation.
contract GovernorQueueOutflowTest is Test, GovernorDeployHelper {
    ArmadaGovernor public governor;
    ArmadaToken public armToken;
    TimelockController public timelock;
    ArmadaTreasuryGov public treasury;
    TreasurySteward public stewardContract;
    QueueOutflowMockToken public usdc;
    QueueOutflowMockToken public other;

    address public deployer = address(this);
    address public alice = address(0xA11CE);
    address public bob = address(0xB0B);
    address public stewardPerson = address(0xDA7E);

    uint256 constant TOTAL_SUPPLY = 12_000_000 * 1e18;
    uint256 constant TWO_DAYS = 2 days;
    uint256 constant SEVEN_DAYS = 7 days;

    // USDC outflow parameters: 30d window, 1% of balance, floor 50k, abs cap 100k.
    // Treasury holds 10M USDC → effective limit = max(1% of 10M, 100k, 50k) = 100k.
    // Treasury is sized large enough that the 5% "force Extended" classification
    // threshold (500k) stays above our test amounts — keeping proposals on the
    // Standard timing track (7d voting) rather than Extended (14d).
    uint256 constant USDC_DECIMALS_VAL = 6;
    uint256 constant USDC_TREASURY_BALANCE = 10_000_000 * 1e6;
    uint256 constant USDC_EFFECTIVE_LIMIT = 100_000 * 1e6;
    uint256 constant USDC_WINDOW = 30 days;
    uint256 constant USDC_LIMIT_BPS = 100; // 1%
    uint256 constant USDC_LIMIT_ABS = 100_000 * 1e6;
    uint256 constant USDC_FLOOR = 50_000 * 1e6;

    // Second token ("other") outflow parameters: effective limit = 10k.
    // Treasury balance 1M → 5% (50k) stays above our 10k test amounts.
    uint256 constant OTHER_DECIMALS_VAL = 18;
    uint256 constant OTHER_TREASURY_BALANCE = 1_000_000 * 1e18;
    uint256 constant OTHER_EFFECTIVE_LIMIT = 10_000 * 1e18;
    uint256 constant OTHER_LIMIT_BPS = 100; // 1%
    uint256 constant OTHER_LIMIT_ABS = 10_000 * 1e18;
    uint256 constant OTHER_FLOOR = 5_000 * 1e18;

    // ETH outflow parameters under the address(0) sentinel.
    // Treasury balance 10000 ETH → 5% (500 ETH) stays above the 100 ETH effective limit
    // and our test amounts, so proposals stay on the Standard timing track.
    uint256 constant ETH_TREASURY_BALANCE = 10_000 ether;
    uint256 constant ETH_EFFECTIVE_LIMIT = 100 ether;
    uint256 constant ETH_LIMIT_BPS = 100; // 1%
    uint256 constant ETH_LIMIT_ABS = 100 ether;
    uint256 constant ETH_FLOOR = 50 ether;

    function setUp() public {
        // Deploy timelock (governor will be added as proposer later)
        address[] memory proposers = new address[](0);
        address[] memory executors = new address[](0);
        timelock = new TimelockController(TWO_DAYS, proposers, executors, deployer);

        // Deploy ARM token
        armToken = new ArmadaToken(deployer, address(timelock));

        // Deploy treasury
        treasury = new ArmadaTreasuryGov(address(timelock));

        // Deploy governor
        governor = _deployGovernorProxy(
            address(armToken),
            payable(address(timelock)),
            address(treasury)
        );

        // Deploy steward contract and register it on the governor
        stewardContract = new TreasurySteward(address(timelock));
        governor.setStewardContract(address(stewardContract));

        // Whitelist addresses so ARM transfers work before the global whitelist opens.
        address[] memory whitelist = new address[](4);
        whitelist[0] = deployer;
        whitelist[1] = alice;
        whitelist[2] = address(governor);
        whitelist[3] = stewardPerson;
        armToken.initWhitelist(whitelist);

        // Distribute voting power: alice 20%, bob 15%, treasury 50% (excluded), deployer keeps remainder.
        armToken.transfer(alice, TOTAL_SUPPLY * 20 / 100);
        armToken.transfer(bob, TOTAL_SUPPLY * 15 / 100);
        armToken.transfer(address(treasury), TOTAL_SUPPLY * 50 / 100);
        vm.prank(alice);
        armToken.delegate(alice);
        vm.prank(bob);
        armToken.delegate(bob);
        vm.roll(block.number + 1);

        // Deploy mock tokens and fund the treasury.
        usdc = new QueueOutflowMockToken("Mock USDC", "USDC", uint8(USDC_DECIMALS_VAL));
        other = new QueueOutflowMockToken("Other Token", "OTHER", uint8(OTHER_DECIMALS_VAL));
        usdc.mint(address(treasury), USDC_TREASURY_BALANCE);
        other.mint(address(treasury), OTHER_TREASURY_BALANCE);
        vm.deal(address(treasury), ETH_TREASURY_BALANCE);

        // Initialize outflow configs and steward budgets (timelock-owned).
        vm.startPrank(address(timelock));
        treasury.initOutflowConfig(address(usdc), USDC_WINDOW, USDC_LIMIT_BPS, USDC_LIMIT_ABS, USDC_FLOOR);
        treasury.initOutflowConfig(address(other), USDC_WINDOW, OTHER_LIMIT_BPS, OTHER_LIMIT_ABS, OTHER_FLOOR);
        treasury.initOutflowConfig(address(0), USDC_WINDOW, ETH_LIMIT_BPS, ETH_LIMIT_ABS, ETH_FLOOR);
        // Steward budgets sized large enough that queue-time outflow limit is the binding constraint.
        treasury.addStewardBudgetToken(address(usdc), USDC_EFFECTIVE_LIMIT, USDC_WINDOW);
        treasury.addStewardBudgetToken(address(other), OTHER_EFFECTIVE_LIMIT, USDC_WINDOW);
        vm.stopPrank();

        // Grant timelock roles to the governor so queue/execute work end-to-end.
        timelock.grantRole(timelock.PROPOSER_ROLE(), address(governor));
        timelock.grantRole(timelock.EXECUTOR_ROLE(), address(governor));
        timelock.grantRole(timelock.CANCELLER_ROLE(), address(governor));

        // Elect steward (used by case 3 & 7 where stewardSpend is in the proposal).
        vm.prank(address(timelock));
        stewardContract.electSteward(stewardPerson);

        // Sanity: confirm our calculated effective limits match the treasury's view.
        (uint256 usdcLimit,,) = treasury.getOutflowStatus(address(usdc));
        (uint256 otherLimit,,) = treasury.getOutflowStatus(address(other));
        assertEq(usdcLimit, USDC_EFFECTIVE_LIMIT, "USDC effective limit sanity");
        assertEq(otherLimit, OTHER_EFFECTIVE_LIMIT, "OTHER effective limit sanity");
        // ETH outflow status uses address(this).balance via the address(0) sentinel.
        (uint256 ethLimit,,) = treasury.getOutflowStatus(address(0));
        assertEq(ethLimit, ETH_EFFECTIVE_LIMIT, "ETH effective limit sanity");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Helpers
    // ═══════════════════════════════════════════════════════════════════════

    /// @dev Submit a Standard proposal as alice and advance past voting delay + period
    ///      with a FOR vote large enough to clear quorum and succeed.
    function _proposeAndPassStandard(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        string memory description
    ) internal returns (uint256 proposalId) {
        vm.prank(alice);
        proposalId = governor.propose(ProposalType.Standard, targets, values, calldatas, description);

        // Standard: 2d voting delay, 7d voting period. Move into Active, vote, then move past end.
        vm.warp(block.timestamp + TWO_DAYS + 1);
        vm.prank(alice);
        governor.castVote(proposalId, 1); // FOR
        vm.prank(bob);
        governor.castVote(proposalId, 1); // FOR (ensure quorum met)
        vm.warp(block.timestamp + SEVEN_DAYS + 1);

        assertEq(uint256(governor.state(proposalId)), uint256(ProposalState.Succeeded), "expected Succeeded");
    }

    /// @dev Submit a Steward proposal and advance past the voting period (pass-by-default).
    function _proposeAndPassSteward(
        address[] memory tokens,
        address[] memory recipients,
        uint256[] memory amounts
    ) internal returns (uint256 proposalId) {
        vm.prank(stewardPerson);
        proposalId = governor.proposeStewardSpend(tokens, recipients, amounts, "steward spend");
        // Steward: 0 voting delay, 7d voting period.
        vm.warp(block.timestamp + SEVEN_DAYS + 1);
        assertEq(uint256(governor.state(proposalId)), uint256(ProposalState.Succeeded), "expected Succeeded");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Case 1: single distribute() where amount > effectiveLimit → queue reverts
    // ═══════════════════════════════════════════════════════════════════════

    // WHY: A standard proposal with a single distribute() whose amount exceeds the
    // token's effective outflow limit can never execute. Issue #235 requires queue()
    // to reject it so it doesn't sit in the timelock indefinitely.
    function test_queue_revertsWhenSingleDistributeExceedsEffectiveLimit() public {
        address[] memory targets = new address[](1);
        targets[0] = address(treasury);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = abi.encodeWithSignature(
            "distribute(address,address,uint256)",
            address(usdc), bob, USDC_EFFECTIVE_LIMIT + 1
        );

        uint256 proposalId = _proposeAndPassStandard(targets, values, calldatas, "exceed-limit distribute");

        vm.expectRevert(abi.encodeWithSelector(ArmadaGovernor.Gov_OutflowInfeasible.selector));
        governor.queue(proposalId);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Case 2: single distribute() within effectiveLimit but > available → queue succeeds
    // ═══════════════════════════════════════════════════════════════════════

    // WHY: The spec distinguishes "permanently impossible" (exceeds effective limit)
    // from "temporarily blocked" (fits limit but exceeds available budget). Only the
    // former is rejected at queue time; the latter must still queue and retry later.
    function test_queue_succeedsWhenDistributeFitsLimitButExceedsAvailable() public {
        // Consume almost all available budget first via a prior timelock-owned distribute.
        uint256 priorSpend = USDC_EFFECTIVE_LIMIT - 1; // leave 1 unit of available budget
        vm.prank(address(timelock));
        treasury.distribute(address(usdc), bob, priorSpend);

        // Now propose a distribute that fits under effectiveLimit but exceeds available.
        uint256 newAmount = USDC_EFFECTIVE_LIMIT; // equals the ceiling; available is 1
        address[] memory targets = new address[](1);
        targets[0] = address(treasury);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = abi.encodeWithSignature(
            "distribute(address,address,uint256)",
            address(usdc), alice, newAmount
        );

        uint256 proposalId = _proposeAndPassStandard(targets, values, calldatas, "temporarily blocked");

        // Must succeed — queue-time check compares against the ceiling, not available.
        governor.queue(proposalId);
        assertEq(uint256(governor.state(proposalId)), uint256(ProposalState.Queued));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Case 3: single stewardSpend() where amount > effectiveLimit → queue reverts
    // ═══════════════════════════════════════════════════════════════════════

    // WHY: Steward proposals use a different selector but the same token aggregation
    // rules apply. Without matching stewardSpend(), an infeasible steward proposal
    // would slip past the check and occupy the queue.
    function test_queue_revertsWhenStewardSpendExceedsEffectiveLimit() public {
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);
        address[] memory recipients = new address[](1);
        recipients[0] = alice;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = USDC_EFFECTIVE_LIMIT + 1;

        uint256 proposalId = _proposeAndPassSteward(tokens, recipients, amounts);

        vm.expectRevert(abi.encodeWithSelector(ArmadaGovernor.Gov_OutflowInfeasible.selector));
        governor.queue(proposalId);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Case 4: batched distribute(USDC, USDC) each fits, aggregate exceeds → reverts
    // ═══════════════════════════════════════════════════════════════════════

    // WHY: Per-token aggregation must sum across the whole proposal batch. Two
    // individually-feasible distributes to the same token can together exceed the
    // limit — and would on execution — so queue() must sum and reject.
    function test_queue_revertsWhenBatchedDistributeAggregateExceedsLimit() public {
        uint256 half = USDC_EFFECTIVE_LIMIT / 2 + 1; // each fits individually, two together exceed
        address[] memory targets = new address[](2);
        targets[0] = address(treasury);
        targets[1] = address(treasury);
        uint256[] memory values = new uint256[](2);
        bytes[] memory calldatas = new bytes[](2);
        calldatas[0] = abi.encodeWithSignature("distribute(address,address,uint256)", address(usdc), alice, half);
        calldatas[1] = abi.encodeWithSignature("distribute(address,address,uint256)", address(usdc), bob, half);

        uint256 proposalId = _proposeAndPassStandard(targets, values, calldatas, "batched usdc");

        vm.expectRevert(abi.encodeWithSelector(ArmadaGovernor.Gov_OutflowInfeasible.selector));
        governor.queue(proposalId);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Case 5: mixed targets — only treasury actions are checked
    // ═══════════════════════════════════════════════════════════════════════

    // WHY: Non-treasury targets don't count against treasury outflow limits. Our
    // check must filter by `targets[i] == treasuryAddress` so unrelated calls in the
    // same proposal don't corrupt aggregation or block legitimate combined proposals.
    function test_queue_onlyAggregatesTreasuryTargetedActions() public {
        // One treasury distribute that fits the limit, plus a non-treasury call using the
        // same 4-byte selector. The non-treasury call would *not* affect the outflow and
        // must be ignored — otherwise the combined "aggregate" would exceed the limit.
        uint256 treasurySpend = USDC_EFFECTIVE_LIMIT;
        uint256 nonTreasurySpend = USDC_EFFECTIVE_LIMIT; // mimics same selector shape, different target

        // Deploy a harmless mock that accepts distribute(address,address,uint256) as a no-op.
        DistributeLookAlike decoy = new DistributeLookAlike();

        address[] memory targets = new address[](2);
        targets[0] = address(treasury);
        targets[1] = address(decoy);
        uint256[] memory values = new uint256[](2);
        bytes[] memory calldatas = new bytes[](2);
        calldatas[0] = abi.encodeWithSignature(
            "distribute(address,address,uint256)", address(usdc), alice, treasurySpend
        );
        calldatas[1] = abi.encodeWithSignature(
            "distribute(address,address,uint256)", address(usdc), alice, nonTreasurySpend
        );

        // The non-treasury-targeted selector is unrecognized by standardSelectors on the
        // decoy target, so classification would force Extended; we propose as Extended.
        vm.prank(alice);
        uint256 proposalId = governor.propose(ProposalType.Extended, targets, values, calldatas, "mixed targets");

        // Extended params: 2d delay, 14d voting, 7d execution, 30% quorum.
        vm.warp(block.timestamp + TWO_DAYS + 1);
        vm.prank(alice);
        governor.castVote(proposalId, 1);
        vm.prank(bob);
        governor.castVote(proposalId, 1);
        // Need additional voter for 30% quorum on ~6M eligible; alice 20% + bob 15% = 35% → ok.
        vm.warp(block.timestamp + 14 days + 1);
        assertEq(uint256(governor.state(proposalId)), uint256(ProposalState.Succeeded));

        // Treasury spend = USDC_EFFECTIVE_LIMIT (exactly at the ceiling, fits). The decoy
        // call with the same selector must NOT be aggregated, else the check would revert.
        governor.queue(proposalId);
        assertEq(uint256(governor.state(proposalId)), uint256(ProposalState.Queued));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Case 6: two tokens, one exceeds its own limit → queue reverts
    // ═══════════════════════════════════════════════════════════════════════

    // WHY: Per-token aggregation must be independent. A proposal that fits one
    // token's limit but exceeds another's must be rejected. Confirms we don't
    // accidentally sum across tokens or only check the first token.
    function test_queue_revertsWhenAnyTokenAggregateExceedsItsLimit() public {
        // USDC distribute fits its limit; OTHER distribute exceeds its limit.
        address[] memory targets = new address[](2);
        targets[0] = address(treasury);
        targets[1] = address(treasury);
        uint256[] memory values = new uint256[](2);
        bytes[] memory calldatas = new bytes[](2);
        calldatas[0] = abi.encodeWithSignature(
            "distribute(address,address,uint256)", address(usdc), alice, USDC_EFFECTIVE_LIMIT
        );
        calldatas[1] = abi.encodeWithSignature(
            "distribute(address,address,uint256)", address(other), alice, OTHER_EFFECTIVE_LIMIT + 1
        );

        uint256 proposalId = _proposeAndPassStandard(targets, values, calldatas, "two tokens");

        vm.expectRevert(abi.encodeWithSelector(ArmadaGovernor.Gov_OutflowInfeasible.selector));
        governor.queue(proposalId);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Case 7: mixed selectors (distribute + stewardSpend, same token) aggregate exceeds
    // ═══════════════════════════════════════════════════════════════════════

    // WHY: Both selectors contribute to the same rolling-window outflow budget, so
    // they must be aggregated together. A proposal that combines them to bypass
    // per-selector-only aggregation would otherwise slip past the feasibility check.
    //
    // Note: this is constructed as an Extended proposal because mixing selector types
    // in a single proposal is unusual — Steward proposals are restricted to stewardSpend
    // only by proposeStewardSpend(). In production this combined shape would arise from
    // a governance Extended proposal that intentionally calls both.
    function test_queue_revertsWhenMixedSelectorsAggregateExceedsLimit() public {
        uint256 half = USDC_EFFECTIVE_LIMIT / 2 + 1;
        address[] memory targets = new address[](2);
        targets[0] = address(treasury);
        targets[1] = address(treasury);
        uint256[] memory values = new uint256[](2);
        bytes[] memory calldatas = new bytes[](2);
        calldatas[0] = abi.encodeWithSignature("distribute(address,address,uint256)", address(usdc), alice, half);
        calldatas[1] = abi.encodeWithSignature("stewardSpend(address,address,uint256)", address(usdc), bob, half);

        // stewardSpend is a Standard selector; classification won't force Extended automatically.
        // Submit as Standard; the check must still catch the mixed-selector aggregate.
        uint256 proposalId = _proposeAndPassStandard(targets, values, calldatas, "mixed selectors");

        vm.expectRevert(abi.encodeWithSelector(ArmadaGovernor.Gov_OutflowInfeasible.selector));
        governor.queue(proposalId);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Regression: happy-path queue still works for a feasible proposal
    // ═══════════════════════════════════════════════════════════════════════

    // WHY: Guard against the new check accidentally over-rejecting. A single
    // distribute at exactly the effective limit must still queue successfully.
    function test_queue_succeedsWhenSingleDistributeAtLimit() public {
        address[] memory targets = new address[](1);
        targets[0] = address(treasury);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = abi.encodeWithSignature(
            "distribute(address,address,uint256)", address(usdc), alice, USDC_EFFECTIVE_LIMIT
        );

        uint256 proposalId = _proposeAndPassStandard(targets, values, calldatas, "at limit");

        governor.queue(proposalId);
        assertEq(uint256(governor.state(proposalId)), uint256(ProposalState.Queued));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ETH parity: queue-time feasibility for distributeETH (address(0) sentinel)
    // ═══════════════════════════════════════════════════════════════════════

    // WHY: distributeETH must obey the same queue-time feasibility check as distribute(),
    // otherwise an infeasible ETH proposal would sit in the timelock indefinitely. The
    // governor decodes (address recipient, uint256 amount) and aggregates against the
    // address(0) bucket.
    function test_queue_revertsWhenSingleDistributeETHExceedsEffectiveLimit() public {
        address[] memory targets = new address[](1);
        targets[0] = address(treasury);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = abi.encodeWithSignature(
            "distributeETH(address,uint256)", bob, ETH_EFFECTIVE_LIMIT + 1
        );

        uint256 proposalId = _proposeAndPassStandard(targets, values, calldatas, "exceed-limit eth");

        vm.expectRevert(abi.encodeWithSelector(ArmadaGovernor.Gov_OutflowInfeasible.selector));
        governor.queue(proposalId);
    }

    // WHY: Two individually-feasible distributeETH calls together exceed the limit.
    // Aggregation under the address(0) bucket must catch this.
    function test_queue_revertsWhenBatchedDistributeETHAggregateExceedsLimit() public {
        uint256 half = ETH_EFFECTIVE_LIMIT / 2 + 1;
        address[] memory targets = new address[](2);
        targets[0] = address(treasury);
        targets[1] = address(treasury);
        uint256[] memory values = new uint256[](2);
        bytes[] memory calldatas = new bytes[](2);
        calldatas[0] = abi.encodeWithSignature("distributeETH(address,uint256)", alice, half);
        calldatas[1] = abi.encodeWithSignature("distributeETH(address,uint256)", bob, half);

        uint256 proposalId = _proposeAndPassStandard(targets, values, calldatas, "batched eth");

        vm.expectRevert(abi.encodeWithSelector(ArmadaGovernor.Gov_OutflowInfeasible.selector));
        governor.queue(proposalId);
    }

    // WHY: Counterpart to the over-rejecting guard for distribute(). A distributeETH
    // at exactly the effective limit must queue successfully — confirms the ETH path
    // doesn't have an off-by-one.
    function test_queue_succeedsWhenSingleDistributeETHAtLimit() public {
        address[] memory targets = new address[](1);
        targets[0] = address(treasury);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = abi.encodeWithSignature(
            "distributeETH(address,uint256)", alice, ETH_EFFECTIVE_LIMIT
        );

        uint256 proposalId = _proposeAndPassStandard(targets, values, calldatas, "eth at limit");

        governor.queue(proposalId);
        assertEq(uint256(governor.state(proposalId)), uint256(ProposalState.Queued));
    }
}

/// @dev A contract that exposes a distribute(address,address,uint256) selector but is
///      NOT the treasury. Used by case 5 to verify the target filter ignores non-treasury
///      actions even when they share the same 4-byte selector.
contract DistributeLookAlike {
    function distribute(address, address, uint256) external pure {
        // no-op — only the selector matters for the queue-time check
    }
}
