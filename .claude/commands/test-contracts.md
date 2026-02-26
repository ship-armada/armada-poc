Run both Hardhat and Foundry test suites and report results.

Steps:
1. Run `npm run test:forge` (Foundry fuzz/invariant tests — no chain dependency)
2. Run `npm run test` (Hardhat integration tests — requires Anvil chains running)
3. If Hardhat tests fail with connection errors, remind the user to start chains with `npm run chains`
4. Summarize: which suites passed, which failed, and any failing test names
