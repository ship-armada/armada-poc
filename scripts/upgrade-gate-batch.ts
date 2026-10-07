// ABOUTME: Builds Safe Transaction Builder files for the Launch Team's UpgradeGate approve/revoke of a proposal,
// ABOUTME: after reading the proposal on-chain, flagging gated actions, and running automated review checks.

import { Contract, Interface, getAddress, type Provider } from "ethers";
import { TX_BUILDER_VERSION, txBuilderChecksum, type ContractMethod, type TxBuilderFile } from "./safe-batch";

export type GateAction = "approve" | "revoke";

/** Everything the Launch Team needs to decide on one proposal. */
export interface GateProposal {
  chainId: number;
  governor: string;
  gate: string;
  launchTeam: string;
  proposalId: bigint;
  state: number;
  approved: boolean;
  targets: string[];
  values: bigint[];
  calldatas: string[];
  /** Per action: whether its selector is gated. */
  gated: boolean[];
  /** Automated review findings; each is a reason for the signers to look harder. */
  findings: string[];
}

const PROPOSAL_INPUTS = [
  { internalType: "uint256", name: "proposalId", type: "uint256" },
  { internalType: "address[]", name: "targets", type: "address[]" },
  { internalType: "uint256[]", name: "values", type: "uint256[]" },
  { internalType: "bytes[]", name: "calldatas", type: "bytes[]" },
];

export const GATE_METHODS: Record<GateAction, ContractMethod> = {
  approve: { inputs: PROPOSAL_INPUTS, name: "approve", payable: false },
  revoke: { inputs: PROPOSAL_INPUTS, name: "revoke", payable: false },
};

const STATE_NAMES = ["Pending", "Active", "Defeated", "Succeeded", "Queued", "Executed", "Canceled"];
export const proposalStateName = (state: number): string => STATE_NAMES[state] ?? String(state);
const TERMINAL_STATES = new Set([2, 5, 6]);

const GOVERNOR_ABI = [
  "function upgradeGate() view returns (address)",
  "function state(uint256) view returns (uint8)",
  "function getProposalActions(uint256) view returns (address[] targets, uint256[] values, bytes[] calldatas)",
];
const GATE_ABI = [
  "function launchTeam() view returns (address)",
  "function isGated(bytes4) view returns (bool)",
  "function isApproved(uint256,address[],uint256[],bytes[]) view returns (bool)",
];
const GATED_CALLS = new Interface([
  "function upgradeTo(address newImplementation)",
  "function upgradeToAndCall(address newImplementation, bytes data)",
  "function addAuthorizedDelegator(address delegator)",
]);

/** Human-readable form of one action's call, decoded for the gated functions. */
export function describeCall(calldata: string): string {
  if (calldata.length < 10) return "(no call data)";
  const parsed = GATED_CALLS.parseTransaction({ data: calldata });
  if (parsed) return `${parsed.name}(${parsed.args.map((a) => String(a)).join(", ")})`;
  return `selector ${calldata.slice(0, 10)}, ${(calldata.length - 10) / 2} argument bytes`;
}

/** Automated checks on gated actions: missing code, and governor upgrades that change the gate. */
async function reviewFindings(provider: Provider, governor: string, gate: string,
  targets: string[], calldatas: string[], gated: boolean[]): Promise<string[]> {
  const findings: string[] = [];
  for (let i = 0; i < calldatas.length; i++) {
    if (!gated[i]) continue;
    const parsed = GATED_CALLS.parseTransaction({ data: calldatas[i] });
    if (!parsed) continue;
    const n = i + 1;
    const subject = getAddress(parsed.args[0]);
    if (parsed.name === "addAuthorizedDelegator") {
      if (await provider.getCode(subject) === "0x") {
        findings.push(`Action ${n}: delegator ${subject} is not a contract, so it cannot be canonical RevenueLock code.`);
      }
      continue;
    }
    if (await provider.getCode(subject) === "0x") {
      findings.push(`Action ${n}: new implementation ${subject} has no code.`);
      continue;
    }
    if (getAddress(targets[i]) === getAddress(governor)) {
      try {
        const next = getAddress(await new Contract(subject, GOVERNOR_ABI, provider).upgradeGate());
        if (next !== getAddress(gate)) {
          findings.push(`Action ${n}: the new governor implementation ${subject} trusts a different upgrade gate `
            + `(${next}, not ${getAddress(gate)}). Approving it removes or replaces the Launch Team co-sign.`);
        }
      } catch {
        findings.push(`Action ${n}: the new governor implementation ${subject} has no upgradeGate(); `
          + "approving it removes the Launch Team co-sign.");
      }
    }
  }
  return findings;
}

/** Read one proposal, its gate and the Launch Team, and run the automated review checks. */
export async function readGateProposal(provider: Provider, governorAddress: string, proposalId: bigint): Promise<GateProposal> {
  const governor = new Contract(governorAddress, GOVERNOR_ABI, provider);
  let state: number;
  try {
    state = Number(await governor.state(proposalId));
  } catch {
    throw new Error(`Proposal ${proposalId} does not exist on the governor ${governorAddress}`);
  }
  const gateAddress = getAddress(await governor.upgradeGate());
  const gate = new Contract(gateAddress, GATE_ABI, provider);
  // Read the tuple positionally: ethers' Result is an Array, so a field named "values" would
  // resolve to Array.prototype.values rather than the returned array.
  const actions = await governor.getProposalActions(proposalId);
  const targets: string[] = Array.from(actions[0], (t: string) => getAddress(t));
  const values: bigint[] = Array.from(actions[1], (v: bigint) => BigInt(v));
  const calldatas: string[] = Array.from(actions[2], (c: string) => c);
  const gated: boolean[] = [];
  for (const c of calldatas) gated.push(c.length >= 10 && await gate.isGated(c.slice(0, 10)));
  return {
    chainId: Number((await provider.getNetwork()).chainId),
    governor: getAddress(governorAddress),
    gate: gateAddress,
    launchTeam: getAddress(await gate.launchTeam()),
    proposalId,
    state,
    approved: await gate.isApproved(proposalId, targets, values, calldatas),
    targets, values, calldatas, gated,
    findings: await reviewFindings(provider, governorAddress, gateAddress, targets, calldatas, gated),
  };
}

/** Reasons not to write the file at all: it would be unnecessary or change nothing. */
export function validateGateRequest(p: GateProposal, action: GateAction): string[] {
  const errors: string[] = [];
  if (!p.gated.some(Boolean)) errors.push(`Proposal ${p.proposalId} has no gated action; it needs no Launch Team approval`);
  if (TERMINAL_STATES.has(p.state)) {
    errors.push(`Proposal ${p.proposalId} is ${proposalStateName(p.state)}; an approval change would have no effect`);
  }
  if (action === "approve" && p.approved) errors.push(`Proposal ${p.proposalId} is already approved`);
  if (action === "revoke" && !p.approved) errors.push(`Proposal ${p.proposalId} is not approved; there is nothing to revoke`);
  return errors;
}

/**
 * One Transaction Builder file with a single call: approve or revoke on the gate over the exact
 * proposal. Given as method + input values (data: null) so the builder shows it decoded.
 */
export function gateBatchFile(action: GateAction, p: GateProposal, createdAt: number): TxBuilderFile {
  const file: TxBuilderFile = {
    version: "1.0",
    chainId: String(p.chainId),
    createdAt,
    meta: {
      name: `Armada Launch Team: ${action} proposal ${p.proposalId}`,
      description: `From npx hardhat gate-safe-approve${action === "revoke" ? " --revoke" : ""}. `
        + "Compare the call with summary.md before signing.",
      txBuilderVersion: TX_BUILDER_VERSION,
      createdFromSafeAddress: p.launchTeam,
      createdFromOwnerAddress: "",
    },
    transactions: [{
      to: p.gate, value: "0", data: null, contractMethod: GATE_METHODS[action],
      contractInputsValues: {
        proposalId: p.proposalId.toString(),
        targets: `[${p.targets.join(",")}]`,
        values: `[${p.values.map((v) => v.toString()).join(",")}]`,
        calldatas: `[${p.calldatas.join(",")}]`,
      },
    }],
  };
  return { ...file, meta: { ...file.meta, checksum: txBuilderChecksum(file) } };
}

/** The signers' review sheet: every action, the automated findings, and the manual checklist. */
export function renderGateSummary(p: GateProposal, action: GateAction): string {
  const rows = p.targets.map((t, i) =>
    `| ${i + 1} | ${p.gated[i] ? "**GATED**" : ""} | \`${t}\` | ${p.values[i]} | \`${describeCall(p.calldatas[i])}\` |`);
  const lines = [
    `# Launch Team: ${action} proposal ${p.proposalId}`,
    "",
    `- Chain: ${p.chainId}`,
    `- Governor: ${p.governor}`,
    `- Upgrade gate: ${p.gate}`,
    `- Launch Team Safe: ${p.launchTeam}`,
    `- Proposal ${p.proposalId} state: ${proposalStateName(p.state)}; currently ${p.approved ? "approved" : "not approved"}`,
    "",
    "## Actions",
    "",
    "| # | | Target | Value (wei) | Call |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    "## Automated findings",
    "",
    ...(p.findings.length ? p.findings.map((f) => `- ⚠️ ${f}`) : ["- None."]),
    "",
  ];
  if (action === "approve") {
    lines.push(
      "## Before approving",
      "",
      "The approval covers this proposal exactly as listed, and only this proposal. Check every gated action:",
      "",
      "- **Upgrades:** the new implementation's source matches the reviewed/audited commit (verified on the block "
        + "explorer); its storage layout extends the current one without reordering; for the governor, `upgradeGate()` "
        + "returns this gate and wind-down still works (`setWindDownActive` from the wind-down contract); for "
        + "RevenueCounter, `freeze()` and `recognizedRevenueUsd()` behave as before.",
      "- **`upgradeToAndCall`:** the attached call is what the proposal description says.",
      "- **`addAuthorizedDelegator`:** the address runs canonical RevenueLock code (compare runtime bytecode with "
        + "a build of the audited source, ignoring constructor immutables) and only ever delegates the releasing "
        + "beneficiary's own tokens.",
      "- **Ungated actions** in the same proposal are part of what you approve; read them too.",
      "",
    );
  } else {
    lines.push("## Revoking", "", "After this executes, the proposal cannot execute until the Launch Team approves it again.", "");
  }
  lines.push(
    "In the Safe app: Apps → Transaction Builder → drag in the JSON file → check the call against the table above → "
      + "Create batch → Simulate → sign. A second owner confirms in Transactions → Queue and executes.",
    "",
  );
  return lines.join("\n");
}
