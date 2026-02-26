Set up a fresh local development environment.

Steps:
1. Run `npm run clean` to remove stale artifacts and deployment manifests
2. Run `npm run compile` to compile all contracts
3. Confirm Anvil chains are running (check if ports 8545, 8546, 8547 are listening). If not, remind the user to run `npm run chains` in a separate terminal.
4. Run `npm run setup` to deploy all contracts in the correct order
5. Report the deployment status and any errors
