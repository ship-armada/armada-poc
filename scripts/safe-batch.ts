// ABOUTME: Builds Safe Transaction Builder batch files for launch-team seeds/invites (from a CSV) and the
// ABOUTME: security-council cancel, after checking every row against the crowdfund's on-chain state.

import { Contract, getAddress, id, isAddress, type Provider } from "ethers";

/** Transaction Builder release the file format was checked against (safe-react-apps apps/tx-builder). */
export const TX_BUILDER_VERSION = "1.18.3";
/** ~5M gas each: seeds cost ~48k, launch-team invites ~84k, under the ~16.7M per-transaction cap. */
export const DEFAULT_MAX_SEEDS_PER_BATCH = 100;
export const DEFAULT_MAX_INVITES_PER_BATCH = 60;

export type Hop = 0 | 1 | 2;

/** One CSV row: hop 0 = seed, hop 1/2 = launch-team invite to that (target) hop. */
export interface LaunchRow {
  line: number;
  address: string;
  hop: Hop;
  label: string;
}

export interface ParticipantSlot {
  isWhitelisted: boolean;
  invitesReceived: number;
}

/** The crowdfund state the rows are checked against. `slots` is keyed by lowercase address, indexed by hop. */
export interface LaunchState {
  chainId: number;
  crowdfund: string;
  launchTeam: string;
  now: number;
  phase: number;
  armLoaded: boolean;
  windowStart: number;
  launchTeamInviteEnd: number;
  maxSeeds: number;
  seedCount: number;
  hop1Budget: number;
  hop1Used: number;
  hop2Budget: number;
  hop2Used: number;
  maxInvitesReceived: [number, number, number];
  slots: Record<string, Array<ParticipantSlot | undefined>>;
}

export interface LaunchValidation {
  errors: string[];
  warnings: string[];
  /** Invite rows that raise an already-invited address's invites received. */
  stacked: LaunchRow[];
}

export interface LaunchBatch {
  kind: "seeds" | "invites";
  rows: LaunchRow[];
}

export interface ContractMethod {
  inputs: Array<{ internalType: string; name: string; type: string }>;
  name: string;
  payable: boolean;
}

export interface TxBuilderTransaction {
  to: string;
  value: string;
  data: string | null;
  contractMethod?: ContractMethod;
  contractInputsValues?: Record<string, string>;
}

export interface TxBuilderFile {
  version: string;
  chainId: string;
  createdAt: number;
  meta: {
    name: string;
    description: string;
    txBuilderVersion: string;
    createdFromSafeAddress: string;
    createdFromOwnerAddress: string;
    checksum?: string;
  };
  transactions: TxBuilderTransaction[];
}

export const LAUNCH_TEAM_METHODS: Record<"addSeeds" | "launchTeamInvite", ContractMethod> = {
  addSeeds: {
    inputs: [{ internalType: "address[]", name: "seeds", type: "address[]" }],
    name: "addSeeds",
    payable: false,
  },
  launchTeamInvite: {
    inputs: [
      { internalType: "address", name: "invitee", type: "address" },
      { internalType: "uint8", name: "fromHop", type: "uint8" },
    ],
    name: "launchTeamInvite",
    payable: false,
  },
};

export const CANCEL_METHOD: ContractMethod = { inputs: [], name: "cancel", payable: false };

const PHASE_NAMES = ["Active", "Finalized", "Canceled"];
const HEADER = ["address", "hop", "label"];

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Parse `address,hop,label` CSV text. Blank lines are skipped; the label may contain commas.
 * Every malformed line is reported at once.
 */
export function parseLaunchCsv(text: string): LaunchRow[] {
  const lines = text.split(/\r?\n/);
  const headerIndex = lines.findIndex((l) => l.trim() !== "");
  const header = headerIndex === -1 ? [] : lines[headerIndex].split(",").map((c) => c.trim().toLowerCase());
  if (header.join(",") !== HEADER.join(",")) {
    throw new Error(`The CSV must start with the header "${HEADER.join(",")}"`);
  }

  const rows: LaunchRow[] = [];
  const errors: string[] = [];
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = i + 1;
    if (lines[i].trim() === "") continue;
    const [rawAddress, rawHop, ...labelParts] = lines[i].split(",");
    const address = rawAddress.trim();
    const hop = rawHop?.trim();
    if (hop === undefined) {
      errors.push(`line ${line}: expected address,hop,label`);
      continue;
    }
    if (!isAddress(address)) {
      errors.push(`line ${line}: "${address}" is not a valid address (or its checksum is wrong)`);
      continue;
    }
    if (!["0", "1", "2"].includes(hop)) {
      errors.push(`line ${line}: hop must be 0 (seed), 1 or 2, got "${hop}"`);
      continue;
    }
    rows.push({ line, address: getAddress(address), hop: Number(hop) as Hop, label: labelParts.join(",").trim() });
  }
  if (errors.length) throw new Error(`Invalid CSV:\n  ${errors.join("\n  ")}`);
  if (!rows.length) throw new Error("The CSV has no rows");
  return rows;
}

const CROWDFUND_READ_ABI = [
  "function launchTeam() view returns (address)",
  "function securityCouncil() view returns (address)",
  "function phase() view returns (uint8)",
  "function armLoaded() view returns (bool)",
  "function windowStart() view returns (uint256)",
  "function launchTeamInviteEnd() view returns (uint256)",
  "function MAX_SEEDS() view returns (uint8)",
  "function LAUNCH_TEAM_HOP1_BUDGET() view returns (uint8)",
  "function LAUNCH_TEAM_HOP2_BUDGET() view returns (uint8)",
  "function launchTeamHop1Used() view returns (uint8)",
  "function launchTeamHop2Used() view returns (uint8)",
  "function HOP0_MAX_INVITES_RECEIVED() view returns (uint16)",
  "function HOP1_MAX_INVITES_RECEIVED() view returns (uint16)",
  "function HOP2_MAX_INVITES_RECEIVED() view returns (uint16)",
  "function hopStats(uint256) view returns (uint256 totalCommitted, uint256 cappedCommitted, uint32 uniqueCommitters, uint32 whitelistCount)",
  "function participants(address, uint8) view returns (address invitedBy, uint16 invitesReceived, uint16 invitesSent, bool isWhitelisted, uint256 committed)",
];

/** Read the crowdfund state needed to check `rows` (including each row's existing participant slot). */
export async function readLaunchState(provider: Provider, crowdfundAddress: string, rows: LaunchRow[]): Promise<LaunchState> {
  const cf = new Contract(crowdfundAddress, CROWDFUND_READ_ABI, provider);
  const [network, block] = await Promise.all([provider.getNetwork(), provider.getBlock("latest")]);
  const [launchTeam, phase, armLoaded, windowStart, inviteEnd, maxSeeds, hop1Budget, hop2Budget,
    hop1Used, hop2Used, max0, max1, max2, hop0Stats] = await Promise.all([
    cf.launchTeam(), cf.phase(), cf.armLoaded(), cf.windowStart(), cf.launchTeamInviteEnd(), cf.MAX_SEEDS(),
    cf.LAUNCH_TEAM_HOP1_BUDGET(), cf.LAUNCH_TEAM_HOP2_BUDGET(), cf.launchTeamHop1Used(), cf.launchTeamHop2Used(),
    cf.HOP0_MAX_INVITES_RECEIVED(), cf.HOP1_MAX_INVITES_RECEIVED(), cf.HOP2_MAX_INVITES_RECEIVED(), cf.hopStats(0),
  ]);

  const slots: LaunchState["slots"] = {};
  for (const r of rows) {
    const key = r.address.toLowerCase();
    slots[key] ??= [];
    if (slots[key][r.hop] === undefined) {
      const p = await cf.participants(r.address, r.hop);
      slots[key][r.hop] = { isWhitelisted: p.isWhitelisted, invitesReceived: Number(p.invitesReceived) };
    }
  }

  return {
    chainId: Number(network.chainId), crowdfund: getAddress(crowdfundAddress), launchTeam: getAddress(launchTeam),
    now: block!.timestamp, phase: Number(phase), armLoaded,
    windowStart: Number(windowStart), launchTeamInviteEnd: Number(inviteEnd),
    maxSeeds: Number(maxSeeds), seedCount: Number(hop0Stats.whitelistCount),
    hop1Budget: Number(hop1Budget), hop1Used: Number(hop1Used), hop2Budget: Number(hop2Budget), hop2Used: Number(hop2Used),
    maxInvitesReceived: [Number(max0), Number(max1), Number(max2)], slots,
  };
}

/** The security council and phase, for the cancel() batch. */
export async function readCancelTarget(provider: Provider, crowdfundAddress: string): Promise<{ chainId: number; securityCouncil: string; phase: number }> {
  const cf = new Contract(crowdfundAddress, CROWDFUND_READ_ABI, provider);
  const [network, securityCouncil, phase] = await Promise.all([provider.getNetwork(), cf.securityCouncil(), cf.phase()]);
  return { chainId: Number(network.chainId), securityCouncil: getAddress(securityCouncil), phase: Number(phase) };
}

export const phaseName = (phase: number): string => PHASE_NAMES[phase] ?? String(phase);

/**
 * Check rows against the crowdfund state so no batch reverts on chain. Errors block writing any
 * file; warnings are printed. Stacked invites (to an address already invited at that hop, or
 * repeated in the file) raise that address's cap and invite budget, so they need `allowStack`.
 */
export function validateLaunchRows(rows: LaunchRow[], state: LaunchState, opts: { allowStack: boolean }): LaunchValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const stacked: LaunchRow[] = [];

  if (state.phase !== 0) errors.push(`The crowdfund is not active (phase ${phaseName(state.phase)})`);
  if (!state.armLoaded) errors.push("ARM is not loaded on the crowdfund");
  if (state.now >= state.launchTeamInviteEnd) {
    errors.push(`The launch-team window closed at ${iso(state.launchTeamInviteEnd)}`);
  } else if (state.now < state.windowStart) {
    warnings.push(`The sale opens at ${iso(state.windowStart)}: these batches can be signed now, but execute only after it opens.`);
  }

  const slot = (r: LaunchRow) => state.slots[r.address.toLowerCase()]?.[r.hop];
  const firstSeen = new Map<string, number>();
  const receivedSoFar = new Map<string, number>();
  for (const r of rows) {
    if (r.address.toLowerCase() === state.launchTeam.toLowerCase()) {
      errors.push(`line ${r.line}: ${r.address} is the launch team, which cannot be a seed or invitee`);
      continue;
    }
    const key = `${r.address.toLowerCase()}@${r.hop}`;
    const existing = slot(r)?.isWhitelisted ? slot(r)!.invitesReceived : 0;
    if (r.hop === 0) {
      if (firstSeen.has(key)) errors.push(`line ${r.line}: seed ${r.address} repeats line ${firstSeen.get(key)}`);
      else if (existing > 0) errors.push(`line ${r.line}: ${r.address} is already a seed`);
      firstSeen.set(key, firstSeen.get(key) ?? r.line);
      continue;
    }
    const received = (receivedSoFar.get(key) ?? existing) + 1;
    receivedSoFar.set(key, received);
    if (received > state.maxInvitesReceived[r.hop]) {
      errors.push(`line ${r.line}: ${r.address} would receive ${received} hop-${r.hop} invites; an address can receive at most ${state.maxInvitesReceived[r.hop]}`);
    } else if (received > 1) {
      if (opts.allowStack) {
        stacked.push(r);
        warnings.push(`line ${r.line}: ${r.address} is stacked at hop ${r.hop} (invite ${received} of at most ${state.maxInvitesReceived[r.hop]}), raising their cap and invite budget`);
      } else {
        errors.push(`line ${r.line}: ${r.address} is already invited at hop ${r.hop}; inviting again raises their cap and invite budget. Pass --allow-stack if intended`);
      }
    }
  }

  const count = (hop: Hop) => rows.filter((r) => r.hop === hop).length;
  const seedsLeft = state.maxSeeds - state.seedCount;
  if (count(0) > seedsLeft) {
    errors.push(`Too many seeds: ${plural(count(0), "seed")}, ${seedsLeft} left (cap ${state.maxSeeds}, ${state.seedCount} added)`);
  }
  for (const [hop, budget, used] of [[1, state.hop1Budget, state.hop1Used], [2, state.hop2Budget, state.hop2Used]] as const) {
    if (count(hop) > budget - used) {
      errors.push(`Too many hop-${hop} invites: ${plural(count(hop), `hop-${hop} invite`)}, ${budget - used} left in the launch-team budget (${budget})`);
    }
  }
  return { errors, warnings, stacked };
}

/** Split rows into batches: all seeds first, then invites, one kind per batch, in file order. */
export function planLaunchBatches(rows: LaunchRow[], limits: { maxSeeds: number; maxInvites: number }): LaunchBatch[] {
  const chunk = (kind: LaunchBatch["kind"], list: LaunchRow[], size: number): LaunchBatch[] => {
    const out: LaunchBatch[] = [];
    for (let i = 0; i < list.length; i += size) out.push({ kind, rows: list.slice(i, i + size) });
    return out;
  };
  return [
    ...chunk("seeds", rows.filter((r) => r.hop === 0), limits.maxSeeds),
    ...chunk("invites", rows.filter((r) => r.hop !== 0), limits.maxInvites),
  ];
}

// The Transaction Builder's checksum (safe-react-apps apps/tx-builder/src/lib/checksum.ts):
// keccak256 of a key-sorted serialization with meta.name nulled. On import it deletes
// meta.checksum and recomputes; a mismatch shows a "this file was modified" warning.
const stringifyReplacer = (_: string, value: unknown) => (value === undefined ? null : value);
function serializeJSONObject(json: unknown): string {
  if (Array.isArray(json)) return `[${json.map((el) => serializeJSONObject(el)).join(",")}]`;
  if (typeof json === "object" && json !== null) {
    const keys = Object.keys(json).sort();
    let acc = `{${JSON.stringify(keys, stringifyReplacer)}`;
    for (const key of keys) acc += `${serializeJSONObject((json as Record<string, unknown>)[key])},`;
    return `${acc}}`;
  }
  return `${JSON.stringify(json, stringifyReplacer)}`;
}

export function txBuilderChecksum(file: TxBuilderFile): string {
  return id(serializeJSONObject({ ...file, meta: { ...file.meta, name: null } }));
}

function withChecksum(file: TxBuilderFile): TxBuilderFile {
  return { ...file, meta: { ...file.meta, checksum: txBuilderChecksum(file) } };
}

/**
 * One Transaction Builder file = one Safe transaction. Calls are given as method + input values
 * (data: null), so the builder encodes them itself and shows them decoded for review.
 */
export function launchBatchFile(batch: LaunchBatch, index: number, total: number, state: LaunchState, createdAt: number): TxBuilderFile {
  const transactions: TxBuilderTransaction[] = batch.kind === "seeds"
    ? [{
      to: state.crowdfund, value: "0", data: null, contractMethod: LAUNCH_TEAM_METHODS.addSeeds,
      contractInputsValues: { seeds: `[${batch.rows.map((r) => r.address).join(",")}]` },
    }]
    : batch.rows.map((r) => ({
      to: state.crowdfund, value: "0", data: null, contractMethod: LAUNCH_TEAM_METHODS.launchTeamInvite,
      contractInputsValues: { invitee: r.address, fromHop: String(r.hop - 1) },
    }));
  return withChecksum({
    version: "1.0",
    chainId: String(state.chainId),
    createdAt,
    meta: {
      name: `Armada launch team ${index}/${total}: ${plural(batch.rows.length, batch.kind === "seeds" ? "seed" : "invite")}`,
      description: `Batch ${index} of ${total} from npx hardhat cf-safe-batch. Execute in order; compare every call with summary.md.`,
      txBuilderVersion: TX_BUILDER_VERSION,
      createdFromSafeAddress: state.launchTeam,
      createdFromOwnerAddress: "",
    },
    transactions,
  });
}

/** The security council's emergency cancel() as a one-transaction batch file. */
export function cancelBatchFile(chainId: number, crowdfund: string, securityCouncil: string, createdAt: number): TxBuilderFile {
  return withChecksum({
    version: "1.0",
    chainId: String(chainId),
    createdAt,
    meta: {
      name: "Armada security council: cancel the crowdfund",
      description: "Emergency cancel from npx hardhat cf-safe-cancel. Immediate and irreversible: every participant can claim a full refund.",
      txBuilderVersion: TX_BUILDER_VERSION,
      createdFromSafeAddress: getAddress(securityCouncil),
      createdFromOwnerAddress: "",
    },
    transactions: [{
      to: getAddress(crowdfund), value: "0", data: null, contractMethod: CANCEL_METHOD, contractInputsValues: {},
    }],
  });
}

/** Batch file name, e.g. batch-2-of-5-invites.json. */
export function batchFileName(batch: LaunchBatch, index: number, total: number): string {
  return `batch-${index}-of-${total}-${batch.kind}.json`;
}

/** The second signer's checklist: every call in every batch, with budgets and warnings. */
export function renderLaunchSummary(args: {
  state: LaunchState;
  csvName: string;
  csvSha256: string;
  batches: LaunchBatch[];
  validation: LaunchValidation;
}): string {
  const { state, csvName, csvSha256, batches, validation } = args;
  const total = batches.length;
  const run = (hop: Hop) => batches.flatMap((b) => b.rows).filter((r) => r.hop === hop).length;
  const stacked = new Set(validation.stacked.map((r) => r.line));
  const cell = (s: string) => s.replace(/\|/g, "\\|");

  const out = [
    "# Launch-team Safe batches",
    "",
    `- Chain: ${state.chainId}`,
    `- Crowdfund: ${state.crowdfund}`,
    `- Launch-team Safe: ${state.launchTeam}`,
    `- Input: ${csvName} (sha256 ${csvSha256})`,
    `- Chain time when generated: ${iso(state.now)}`,
    `- Sale opens: ${iso(state.windowStart)}; launch-team window closes: ${iso(state.launchTeamInviteEnd)}`,
    "",
    "## Budgets",
    "",
    "| | Before | This run | After | Limit |",
    "|---|---|---|---|---|",
    `| Seeds | ${state.seedCount} | ${run(0)} | ${state.seedCount + run(0)} | ${state.maxSeeds} |`,
    `| Launch-team hop-1 invites | ${state.hop1Used} | ${run(1)} | ${state.hop1Used + run(1)} | ${state.hop1Budget} |`,
    `| Launch-team hop-2 invites | ${state.hop2Used} | ${run(2)} | ${state.hop2Used + run(2)} | ${state.hop2Budget} |`,
    "",
    "## Warnings",
    "",
    ...(validation.warnings.length ? validation.warnings.map((w) => `- ${w}`) : ["- None"]),
    "",
    "## How to execute",
    "",
    "1. Execute the batches in order, one Safe transaction each. In the Safe app: Apps → Transaction Builder →",
    "   drag in the file → check every call against the table below → Create batch → Simulate → sign.",
    "2. The second owner opens Transactions → Queue, checks the calls against this file, confirms and executes.",
    "3. Execute every batch before running cf-safe-batch again: its checks cannot see batches still in the Safe queue.",
  ];
  batches.forEach((b, i) => {
    out.push("", `## Batch ${i + 1} of ${total}: ${batchFileName(b, i + 1, total)}`, "");
    out.push(b.kind === "seeds"
      ? `One call: addSeeds with ${plural(b.rows.length, "address")}, in this order.`
      : `${plural(b.rows.length, "call")} to launchTeamInvite(invitee, fromHop), in this order.`);
    // The Safe app decodes launchTeamInvite's fromHop (target hop − 1); show it for comparison.
    out.push("", "| # | CSV line | Address | Target hop | fromHop in Safe | Label | Note |", "|---|---|---|---|---|---|---|");
    b.rows.forEach((r, j) => {
      const fromHop = r.hop === 0 ? "—" : String(r.hop - 1);
      out.push(`| ${j + 1} | ${r.line} | ${r.address} | ${r.hop} | ${fromHop} | ${cell(r.label)} | ${stacked.has(r.line) ? "stacked" : ""} |`);
    });
  });
  return out.join("\n") + "\n";
}
