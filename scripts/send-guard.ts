// ABOUTME: Provider wrappers for live deploys: log each send's nonce and hash, retry a Ledger signature
// ABOUTME: that failed before broadcast, keep the Ledger the only account, and apply gasMultiplier headroom.

import { extendProvider } from "hardhat/config";
import { ProviderWrapper } from "hardhat/plugins";
import type { EIP1193Provider, RequestArguments } from "hardhat/types";
import { Transaction, toQuantity } from "ethers";
import * as readline from "readline/promises";

export const LEDGER_PLUGIN_NAME = "@nomicfoundation/hardhat-ledger";

export interface SendGuardIO {
  log(message: string): void;
  /** Ask the operator a yes/no question; resolves true only on an explicit yes. */
  confirmRetry(question: string): Promise<boolean>;
}

/**
 * True for errors raised by the Ledger plugin itself (device rejected, locked, disconnected,
 * address not found). The plugin raises these before eth_sendRawTransaction, so nothing was
 * broadcast. RPC errors from the broadcast are re-thrown unwrapped and never match.
 */
export function isPreBroadcastLedgerError(error: unknown): boolean {
  return (error as { pluginName?: unknown } | null)?.pluginName === LEDGER_PLUGIN_NAME;
}

/** The nonce a send request carries, for logging. */
function sendNonce(args: RequestArguments): string {
  const [tx] = (args.params ?? []) as unknown[];
  try {
    if (args.method === "eth_sendRawTransaction") return String(Transaction.from(tx as string).nonce);
    const nonce = (tx as { nonce?: string } | undefined)?.nonce;
    return nonce === undefined ? "?" : String(Number(nonce));
  } catch {
    return "?";
  }
}

/**
 * Wraps the provider below hardhat-ledger (or the HTTP provider on a hot-key run). Every send
 * logs "nonce N → hash" as soon as it is accepted, so a stuck or dropped transaction can be
 * identified. When a Ledger signature fails before broadcast, the operator may retry the
 * identical request: same nonce and fee fields, so no nonce is skipped. A retry after a long
 * pause re-uses the original fee cap, so it can sit pending until the base fee falls back.
 */
export class SendGuardProvider extends ProviderWrapper {
  constructor(provider: EIP1193Provider, private readonly _io: SendGuardIO) {
    super(provider);
  }

  public async request(args: RequestArguments): Promise<unknown> {
    if (args.method !== "eth_sendTransaction" && args.method !== "eth_sendRawTransaction") {
      return this._wrappedProvider.request(args);
    }
    const nonce = sendNonce(args);
    for (;;) {
      try {
        const hash = await this._wrappedProvider.request(args);
        this._io.log(`   [send] nonce ${nonce} → ${hash} (waiting for receipt)`);
        return hash;
      } catch (error) {
        if (args.method !== "eth_sendTransaction" || !isPreBroadcastLedgerError(error)) throw error;
        const retry = await this._io.confirmRetry(
          `\n   Ledger signing failed: ${(error as Error).message}\n` +
          `   nothing was broadcast — nonce ${nonce} is still unused.\n` +
          `   Retry the same transaction on the device? [y/N] `
        );
        if (!retry) throw error;
      }
    }
  }
}

/** Console IO for the guard. A non-interactive stdin never retries. */
export const consoleSendGuardIO: SendGuardIO = {
  log: (message) => console.log(message),
  async confirmRetry(question) {
    if (!process.stdin.isTTY) {
      console.error(`${question}\n   (stdin is not interactive — not retrying)`);
      return false;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      return /^y(es)?$/i.test((await rl.question(question)).trim());
    } finally {
      rl.close();
    }
  },
};

/**
 * Lists only the Ledger address for eth_accounts. hardhat-ledger appends its accounts AFTER the
 * RPC node's own, so a node exposing unlocked accounts (Anvil, a local node, a misconfigured
 * RPC) would otherwise become signer[0] and sign the deploy instead of the device.
 */
export class LedgerOnlyAccountsProvider extends ProviderWrapper {
  constructor(provider: EIP1193Provider, private readonly _ledgerAddress: string) {
    super(provider);
  }

  public async request(args: RequestArguments): Promise<unknown> {
    if (args.method === "eth_accounts" || args.method === "eth_requestAccounts") {
      return [this._ledgerAddress];
    }
    return this._wrappedProvider.request(args);
  }
}

/** EIP-7825 (Fusaka): no transaction may set a gas limit above 2^24. */
export const TRANSACTION_GAS_LIMIT_CAP = 16_777_216n;

/** Scale an estimate by `multiplier` (rounded up), but never above the per-transaction cap. */
export function withGasHeadroom(estimate: bigint, multiplier: number): bigint {
  const thousandths = BigInt(Math.round(multiplier * 1000));
  const scaled = (estimate * thousandths + 999n) / 1000n;
  const capped = scaled < TRANSACTION_GAS_LIMIT_CAP ? scaled : TRANSACTION_GAS_LIMIT_CAP;
  return capped > estimate ? capped : estimate;
}

/**
 * Applies the network's gasMultiplier to eth_estimateGas results. hardhat-ethers sets each
 * transaction's gas limit from its own estimate, so Hardhat's gasMultiplier (which only fills a
 * missing limit) never applied and launch transactions were signed at exactly their estimate.
 * Only the limit changes: gas used, and so the cost, is whatever the transaction consumes.
 */
export class GasHeadroomProvider extends ProviderWrapper {
  constructor(provider: EIP1193Provider, private readonly _multiplier: number) {
    super(provider);
  }

  public async request(args: RequestArguments): Promise<unknown> {
    const result = await this._wrappedProvider.request(args);
    if (args.method !== "eth_estimateGas") return result;
    return toQuantity(withGasHeadroom(BigInt(result as string), this._multiplier));
  }
}

/** Live networks get the guard; local Anvil and in-process Hardhat networks are left untouched. */
export function isLiveNetwork(networkName: string): boolean {
  return networkName.startsWith("sepolia") || networkName.startsWith("mainnet");
}

/**
 * Register LedgerOnlyAccountsProvider on live networks. Call from hardhat.config.ts AFTER
 * importing @nomicfoundation/hardhat-ledger, so it wraps the Ledger provider's eth_accounts.
 */
export function installLedgerOnlyAccounts(ledgerAddress: string): void {
  extendProvider(async (provider, _config, networkName) =>
    isLiveNetwork(networkName) ? new LedgerOnlyAccountsProvider(provider, ledgerAddress) : provider
  );
}

/** Register GasHeadroomProvider on live networks whose config sets a gasMultiplier above 1. */
export function installGasHeadroom(): void {
  extendProvider(async (provider, config, networkName) => {
    const multiplier = (config.networks[networkName] as { gasMultiplier?: number }).gasMultiplier ?? 1;
    return isLiveNetwork(networkName) && multiplier > 1 ? new GasHeadroomProvider(provider, multiplier) : provider;
  });
}

/**
 * Register the guard as a Hardhat provider extender. Call from hardhat.config.ts AFTER
 * importing @nomicfoundation/hardhat-ledger: later extenders wrap earlier ones, and the guard
 * must sit outside the Ledger provider to see its pre-broadcast errors.
 */
export function installSendGuard(): void {
  extendProvider(async (provider, _config, networkName) =>
    isLiveNetwork(networkName) ? new SendGuardProvider(provider, consoleSendGuardIO) : provider
  );
}
