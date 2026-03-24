// ABOUTME: Shared types, enums, and interfaces for the Armada governance system.
// ABOUTME: Defines ProposalType, ProposalState, ProposalParams, and contract interfaces (governor, steward, token).

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/// @title IArmadaGovernance — Shared types for Armada governance system

// ========== Enums ==========

enum ProposalType {
    Standard,          // 0 — 7d voting, 48h execution, 20% quorum
    Extended,          // 1 — 14d voting, 7d execution, 30% quorum
    VetoRatification,  // 2 — 7d voting, no delay, 20% quorum (auto-created only)
    Steward            // 3 — 7d voting, 2d execution, 20% quorum (pass-by-default, auto-created only)
}

enum ProposalState {
    Pending,     // Voting delay not elapsed
    Active,      // Voting open
    Defeated,    // Quorum not reached or majority against
    Succeeded,   // Passed vote
    Queued,      // In timelock
    Executed,    // Done
    Canceled     // Canceled by proposer
}

// ========== Structs ==========

struct ProposalParams {
    uint256 votingDelay;     // seconds before voting starts
    uint256 votingPeriod;    // duration of voting in seconds
    uint256 executionDelay;  // timelock delay after success in seconds
    uint256 quorumBps;       // quorum in basis points of eligible supply
}

// ========== Interfaces ==========

interface IArmadaGovernorTiming {
    function proposalTypeParams(ProposalType proposalType) external view returns (
        uint256 votingDelay, uint256 votingPeriod, uint256 executionDelay, uint256 quorumBps
    );
}

interface ITreasurySteward {
    function currentSteward() external view returns (address);
    function isStewardActive() external view returns (bool);
}
