Run pre-commit checks to catch common issues before committing.

Steps:
1. Run `git diff --cached` and review staged changes for:
   - Private keys, mnemonics, or seed phrases
   - API keys, auth tokens, or service credentials
   - RPC endpoint URLs with embedded API keys (e.g. Alchemy/Infura URLs)
   - Absolute filesystem paths or usernames that leak system information
   - Any calls to `setTestingMode()` or `VERIFICATION_BYPASS` being enabled
2. Check that any new files with potentially sensitive content have corresponding `.gitignore` entries
3. Run `npm run test:forge` (offline, fast — catches Solidity regressions)
4. If smart contracts were modified, also run `npm run test` (requires Anvil chains)
5. Report: secrets check result, test results, and whether it's safe to commit
