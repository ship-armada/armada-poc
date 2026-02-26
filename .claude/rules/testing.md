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
