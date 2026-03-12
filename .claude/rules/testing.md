---
paths:
  - "test/**"
  - "test-foundry/**"
---

# Testing Rules

- **Run relevant tests before committing.** There is no CI/CD pipeline yet — local test runs are the safety net.
- Two parallel test environments exist and both matter:
  - **Hardhat/Mocha** (`test/`): Integration tests with real Railgun SDK and ZK proof generation. These require local Anvil chains running.
  - **Foundry** (`test-foundry/`): Fuzz, invariant, and boundary tests. Run offline with `forge test --offline`. No chain dependency.
- When modifying smart contracts, run both `npm run test` AND `npm run test:forge` to catch regressions.
- When modifying only TypeScript (relayer, scripts, lib), Hardhat tests are sufficient.
- Foundry invariant config: 256 runs, depth 50. Do not reduce these values.

## Debugging Test Failures

- If tests fail with connection/RPC errors, check that Anvil chains are running (`npm run chains`).
- If Foundry tests pass but Hardhat tests fail, the issue is likely in the TypeScript integration layer (SDK usage, proof generation, relayer logic), not the Solidity contracts.
- If Hardhat tests pass but Foundry tests fail, the issue is likely a boundary condition or invariant violation in the Solidity — check the fuzz test inputs for edge cases.
- Hardhat integration tests generate real ZK proofs and are slow (~30-60s per shield/transact cycle). This is expected.

## Test Documentation: Capture the "Why"

Every test function should have a comment explaining **why** it exists and what invariant or behavior it protects. Future sessions will not have the reasoning context from when the test was written — the comment is the only thing that survives between sessions.

Good:
```
// WHY: Pro-rata allocation with prime-number demand maximizes integer
// rounding error. This verifies no value is created or destroyed.
```

Bad:
```
// Test pro-rata allocation
```

When writing tests, include:
- What scenario or invariant is being tested
- Why this particular case matters (edge case, past bug, security property)
- Any non-obvious setup or constraints
