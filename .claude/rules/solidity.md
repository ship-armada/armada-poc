---
paths:
  - "contracts/**/*.sol"
  - "test-foundry/**/*.sol"
---

# Solidity Rules

- **Solidity version:** 0.8.17. Do not upgrade without discussion — the Railgun contracts have version-specific dependencies.
- **OpenZeppelin version:** 4.9.3. Same constraint — do not upgrade unilaterally.
- **PrivacyPool uses delegatecall module architecture.** All state lives in `PrivacyPoolStorage.sol`. Logic is in separate module contracts (`ShieldModule`, `TransactModule`, `MerkleModule`, `VerifierModule`). When modifying pool logic, edit the relevant module — never add state to module contracts directly.
- **The Railgun internals (`contracts/railgun/logic/`) are adapted from the Railgun open-source codebase.** Modify these with extreme caution. Changes here can break ZK circuit compatibility silently — the contracts will compile fine but ZK proofs will fail at runtime.
- **Yield vault (`ArmadaYieldVault`) is ERC-4626-inspired but intentionally non-standard.** Do not "fix" it to conform to ERC-4626 without explicit discussion.
- **CCTPHookRouter is a custom pattern** — Circle's real CCTP V2 does not auto-dispatch hooks. The router atomically wraps `receiveMessage` + hook dispatch. Understand this before modifying cross-chain flows.
- **Local mocks must faithfully model the real systems.** When building or modifying mock contracts (CCTP, Aave, ERC-20 tokens, etc.), match the real system's interfaces, function signatures, return types, and event signatures exactly. The goal is for the real deployment to be a drop-in replacement — if our mock diverges from the real interface, integration will break silently.
