// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/// @title IArmadaGovernance — Shared types for Armada governance system

// ========== Enums ==========

enum ProposalType {
    ParameterChange,   // Fee tiers, volume thresholds, yield fee rate, etc.
    Treasury,          // Allocations, grants, partnerships
    StewardElection    // Elect/replace treasury steward
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

struct StewardAction {
    uint256 id;
    address target;
    bytes data;
    uint256 value;
    uint256 timestamp;
    bool executed;
    bool vetoed;
}
