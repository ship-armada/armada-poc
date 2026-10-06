# Ledger deploy (Launch 1 orchestrator)

`npm run setup:mainnet` (`scripts/deploy_mainnet.ts`) can sign with a Ledger instead of a
`DEPLOYER_PRIVATE_KEY`. The key never leaves the device, so malware on the deploy machine
(including a compromised npm dependency) cannot copy it. Each transaction, about 61 for the
crowdfund launch (63 with a revenue reserve), needs an approval on the device, so a run takes 30–60 minutes of attended
signing.

Only the Launch 1 orchestrator path (CCTP-record, governance, crowdfund, verify) supports a
Ledger. Other scripts that build a wallet from `DEPLOYER_PRIVATE_KEY` (e.g. `link-client.ts`,
`test_sepolia.ts`) still need a key.

## Setup

1. **Device:** Nano S Plus, Nano X, Stax or Flex (the original Nano S no longer gets Ethereum
   app updates). Update the firmware and the Ethereum app.
2. **Ethereum app settings:** turn on **Blind signing**. Deploys and calls to our contracts
   cannot be decoded on the device, so each prompt shows a hash. The device protects the key;
   the script's read-back checks and `verify_deployment.ts` check what was deployed.
3. **Device auto-lock:** turn it off (or set the longest delay) for the session.
4. **Account:** use an Ethereum account created in Ledger Live. The plugin searches the Ledger
   Live paths `m/44'/60'/<i>'/0/0` for `i` = 0–20.
5. **Funding:** the launch is about 61 transactions using about 28M gas in total, plus about 46k
   gas per RevenueLock beneficiary beyond two. You pay only for gas used, but each transaction
   needs gasLimit × maxFeePerGas available up front, and live networks sign with 2× gas-limit
   headroom (`gasMultiplier`, capped at the 16.77M per-transaction limit). Fund about
   2 × total gas × the expected gas price; the pre-flight prints the balance.
6. **Host:** close Ledger Live and any browser wallet (they hold the USB connection). Keep the
   machine awake for the whole run (`caffeinate -dims` on macOS). Use a private `HUB_RPC`.
7. **Config:** remove `DEPLOYER_PRIVATE_KEY` from `config/secrets.env` and set

   ```bash
   export DEPLOYER_LEDGER_ADDRESS=0x...   # the Ledger account's address
   ```

   Setting both is refused: Hardhat would list the key's account first and sign with it.
8. **Open time:** the orchestrator requires `CROWDFUND_OPEN_TIME` to be at least 6 hours away
   when it starts. For a Ledger run, prefer about 24 hours, so verification, manifest publish,
   frontend pin and indexer start are not rushed.

## During the run

- **Pre-flight.** Right after compiling, the device is asked to sign a message naming the
  chain and `DEPLOY_COMMIT`. No transaction is sent. A locked device, the wrong app or the
  wrong address stops the run here, before anything is on chain.
- **Every transaction** waits for an approval on the device. Hardhat shows
  `[hardhat-ledger] Waiting for confirmation`.
- **Send log.** As soon as a transaction is accepted the script prints
  `[send] nonce N → 0x<hash> (waiting for receipt)`. Keep the terminal output: it is the
  record the interrupted-launch runbook needs if something stalls.
- **Rejected, missed or failed prompt.** If signing fails on the device (rejected, device
  locked, app closed, unplugged), nothing was broadcast. The script asks
  `Retry the same transaction on the device? [y/N]`. Fix the device, answer `y`, and approve:
  the same nonce and fee fields are re-signed, so no nonce is skipped. Answering `N` stops the
  run: follow [interrupted-launch-recovery.md](interrupted-launch-recovery.md).
- **Approve promptly.** The fee cap is fixed when the prompt appears (about 1.27× the next
  block's base fee). After a long pause during rising fees, the transaction can sit pending
  until fees fall back; the script waits. Do not speed it up from another wallet: the script
  is waiting on the original hash and would stop.
- **Do not use the Ledger account anywhere else** until the run finishes. Any other
  transaction moves the nonce and stops the run.
- **Stage handoff.** The crowdfund stage starts at the nonce the governance stage recorded
  (`deployerNonceAfterGovernance` in the governance manifest). It waits out an RPC node that
  is still behind. A nonce *ahead* of the record means the deployer key signed something
  outside the deploy: the stage stops before sending anything. Investigate before continuing.

## Sepolia rehearsal

Run the full hardened flow on Sepolia with the same device, machine and settings before
mainnet:

```bash
source config/sepolia.env
export HARDEN_TIMELOCK=true DEPLOYER_LEDGER_ADDRESS=0x...
unset DEPLOYER_PRIVATE_KEY
npm run setup:mainnet
```

Check during the rehearsal:

- [ ] The pre-flight message shows the expected chain and commit.
- [ ] Reject one transaction prompt on purpose, answer `y`, and approve it. The run continues
      with the same nonce (compare the `[send]` lines).
- [ ] Leave one prompt waiting longer than the device's auto-lock delay. Note whether the device
      locks and how the retry behaves.
- [ ] Note the total run time and the ETH spent, to size the mainnet open time and funding.
- [ ] The run ends with `LAUNCH 1 DEPLOYMENT VERIFIED`. Verification runs in the Launch 1 scope,
      so the repo's older Launch-2 Sepolia manifests are not checked. With `CROWDFUND_OPEN_DELAY`
      instead of `CROWDFUND_OPEN_TIME`, expect one WARN (no configured open time to compare).
      Re-run it by hand with `VERIFY_SCOPE=launch1 npx hardhat run scripts/verify_deployment.ts
      --network sepoliaHub --no-compile`. Afterwards, `git checkout -- deployments/` restores the
      committed Sepolia manifests the rehearsal overwrote.
