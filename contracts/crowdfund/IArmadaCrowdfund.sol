// ABOUTME: Shared types (enums, structs) for the Armada crowdfund system.
// ABOUTME: Imported by ArmadaCrowdfund.sol and test contracts.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/// @title IArmadaCrowdfund — Shared types for Armada crowdfund system

// ========== Enums ==========

enum Phase {
    Active,         // Invites + commits happen concurrently (3-week window)
    Finalized,      // Allocations computed, claims open
    Canceled        // Security Council cancel or permanent shutdown; full refunds
}

// ========== Structs ==========

struct HopConfig {
    uint16 ceilingBps;          // Ceiling as basis points — overlapping (7000, 4500, 0). Hop-2 uses floor+rollover instead.
    uint256 capUsdc;            // Max individual commitment in USDC (6 decimals)
    uint8 maxInvites;           // How many addresses this hop can invite (3, 2, 0)
    uint16 maxInvitesReceived;  // Cap on invite stacking per (address, hop) node
}

struct Participant {
    bool isWhitelisted;     // true after being added as seed or invited
    uint16 invitesReceived; // times invited to this hop — scales cap and outgoing invite budget
    uint256 committed;      // USDC committed (6 decimals)
    address invitedBy;      // who FIRST invited this participant (address(0) for seeds)
    uint16 invitesSent;     // outgoing invites consumed — max = invitesReceived * maxInvites
}

/// @dev Enumeration entry for iterating all (address, hop) nodes.
struct ParticipantNode {
    address addr;
    uint8 hop;
}

struct HopStats {
    uint256 totalCommitted;     // aggregate USDC committed for this hop (raw, including over-cap)
    uint256 cappedCommitted;    // aggregate USDC committed capped at effective caps (set at finalization)
    uint32 uniqueCommitters;    // count of unique addresses that committed > 0
    uint32 whitelistCount;      // count of whitelisted addresses at this hop
}

// ========== Interfaces ==========

/// @notice Read-only interface for cross-contract queries (e.g. governor quiet period).
interface IArmadaCrowdfundReadable {
    function finalizedAt() external view returns (uint256);
}
