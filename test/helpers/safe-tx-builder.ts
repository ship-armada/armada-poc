// ABOUTME: Test helpers that deploy real 2-of-3 Safes and execute Safe Transaction Builder files through them.
// ABOUTME: Mirrors the Safe app: builder-side calldata encoding, MultiSendCallOnly bundling, EIP-712 owner signatures.
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import hre from "hardhat";
import type { TxBuilderFile } from "../../scripts/safe-batch";

/**
 * Mirrors how the Safe Transaction Builder turns an imported file into calldata
 * (safe-react-apps apps/tx-builder/src/utils.ts: parseInputValue / parseStringToArray, and
 * convertToProposedTransactions). A file the builder cannot encode silently becomes "0x", so the
 * values we write must survive exactly this parsing.
 */
export function builderCalldata(tx: TxBuilderFile["transactions"][number]): string {
  if (tx.data) return tx.data;
  const method = tx.contractMethod!;
  const values = method.inputs.map((input) => {
    const raw = (tx.contractInputsValues ?? {})[input.name].trim();
    if (input.type.endsWith("[]")) {
      return raw.slice(1, -1).split(",").map((v) => v.trim().replace(/"/g, "").replace(/'/g, ""));
    }
    return raw;
  });
  const fragment = `function ${method.name}(${method.inputs.map((i) => i.type).join(",")})`;
  return new ethers.Interface([fragment]).encodeFunctionData(method.name, values);
}

// Safe v1.4.1, the version the Safe web app deploys on mainnet, from @safe-global/safe-contracts.
const safeArtifact = (p: string) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "node_modules",
  "@safe-global", "safe-contracts", "build", "artifacts", "contracts", p), "utf8"));
const SAFE = safeArtifact("Safe.sol/Safe.json");
const FACTORY = safeArtifact("proxies/SafeProxyFactory.sol/SafeProxyFactory.json");
const MULTISEND = safeArtifact("libraries/MultiSendCallOnly.sol/MultiSendCallOnly.json");

/**
 * Deploy the Safe singleton, proxy factory and MultiSendCallOnly, and return a factory for
 * 2-of-3 Safes owned by the given three owners.
 */
export async function deploySafeInfra(deployer: any, owners: [any, any, any]) {
  const deploy = async (a: any, ...args: unknown[]) => {
    const c = await new hre.ethers.ContractFactory(a.abi, a.bytecode, deployer).deploy(...args);
    await c.waitForDeployment();
    return c as any;
  };
  const singleton = await deploy(SAFE);
  const factory = await deploy(FACTORY);
  const multiSend = await deploy(MULTISEND);
  let salt = 0;
  const createSafe = async () => {
    const setup = singleton.interface.encodeFunctionData("setup", [owners.map((o) => o.address), 2,
      ethers.ZeroAddress, "0x", ethers.ZeroAddress, ethers.ZeroAddress, 0, ethers.ZeroAddress]);
    const receipt = await (await factory.createProxyWithNonce(await singleton.getAddress(), setup, salt++)).wait();
    const created = receipt.logs.map((l: any) => { try { return factory.interface.parseLog(l); } catch { return null; } })
      .find((e: any) => e?.name === "ProxyCreation");
    return new hre.ethers.Contract(created.args.proxy, SAFE.abi, deployer) as any;
  };
  return { multiSend, createSafe };
}

/**
 * Execute one Transaction Builder file as the Safe app would: calldata encoded from the
 * file's method + values, several calls bundled through MultiSendCallOnly (delegatecall),
 * and two owners' EIP-712 signatures over the SafeTx.
 */
export async function executeFile(safe: any, multiSend: any, owners: any[], file: TxBuilderFile) {
  const calls = file.transactions.map((tx) => ({ to: tx.to, value: BigInt(tx.value), data: builderCalldata(tx) }));
  const single = calls.length === 1;
  const to = single ? calls[0].to : await multiSend.getAddress();
  const data = single ? calls[0].data : multiSend.interface.encodeFunctionData("multiSend", [ethers.concat(calls.map((c) =>
    ethers.solidityPacked(["uint8", "address", "uint256", "uint256", "bytes"], [0, c.to, c.value, ethers.dataLength(c.data), c.data])))]);
  const operation = single ? 0 : 1;
  const message = { to, value: 0n, data, operation, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n,
    gasToken: ethers.ZeroAddress, refundReceiver: ethers.ZeroAddress, nonce: await safe.nonce() };
  const domain = { chainId: Number(file.chainId), verifyingContract: await safe.getAddress() };
  const types = { SafeTx: [
    { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" }, { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" }, { name: "gasToken", type: "address" }, { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" }] };
  const sigs = await Promise.all(owners.map(async (o) => ({ owner: o.address.toLowerCase(), sig: await o.signTypedData(domain, types, message) })));
  sigs.sort((a, b) => (a.owner < b.owner ? -1 : 1));
  await (await safe.connect(owners[0]).execTransaction(to, 0, data, operation, 0, 0, 0,
    ethers.ZeroAddress, ethers.ZeroAddress, ethers.concat(sigs.map((s) => s.sig)))).wait();
}
