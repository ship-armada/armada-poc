/**
 * Runtime-compiled capture-only helper contracts.
 *
 * These mocks are NOT part of the deployed system under test. They exist so the
 * capture harness can drive pool code paths that need a counterpart contract:
 *
 *   - MockShieldPauseController: implements the IShieldPauseController surface
 *     the pool consumes (shieldsPaused / withdrawOnlyMode / emergencyPaused)
 *     with permissionless flag setters. The real ShieldPauseController is gated
 *     by the governor's security council, which is not configured on a bare
 *     local fixturenet.
 *
 *   - MockConfigurableFeeModule: implements the IArmadaFeeModule surface the
 *     pool consumes (calculateShieldFee / recordShieldFee) with a mode switch:
 *       mode 0 = zero fees (well-formed)
 *       mode 1 = malformed: totalFee = amount + 1 (forces checked-subtraction
 *                panic in ShieldModule._transferTokenIn)
 *       mode 2 = reverting: calculateShieldFee always reverts
 *
 * Compiled at capture time with the repo's bundled solc (same major version as
 * the project compiler) so no files are added to contracts/.
 */

import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

// solc is a transitive dependency of hardhat (0.8.26 in this repo).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const solc = require("solc");

const MOCK_SOURCES = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

contract MockShieldPauseController {
    bool public shieldsPaused;
    bool public withdrawOnlyMode;
    bool public emergencyPaused;

    function setShieldsPaused(bool v) external { shieldsPaused = v; }
    function setWithdrawOnlyMode(bool v) external { withdrawOnlyMode = v; }
    function setEmergencyPaused(bool v) external { emergencyPaused = v; }
}

contract MockConfigurableFeeModule {
    uint256 public mode;

    function setMode(uint256 m) external { mode = m; }

    function calculateShieldFee(address, uint256 amount)
        external
        view
        returns (uint256 armadaTake, uint256 integratorFee, uint256 totalFee)
    {
        if (mode == 2) revert("MockFeeModule: boom");
        if (mode == 1) return (0, 0, amount + 1); // malformed: totalFee > amount
        return (0, 0, 0);
    }

    function recordShieldFee(address, address, uint256, uint256, uint256) external {}
}
`;

export interface DeployedMock {
  contract: Contract;
  address: string;
}

function compileMocks(): Record<string, { abi: any; bytecode: string }> {
  const input = {
    language: "Solidity",
    sources: { "CaptureMocks.sol": { content: MOCK_SOURCES } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode"] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  if (output.errors) {
    const fatal = output.errors.filter((e: any) => e.severity === "error");
    if (fatal.length > 0) {
      throw new Error(`solc failed compiling capture mocks: ${JSON.stringify(fatal, null, 2)}`);
    }
  }
  const out: Record<string, { abi: any; bytecode: string }> = {};
  for (const [name, artifact] of Object.entries<any>(output.contracts["CaptureMocks.sol"])) {
    out[name] = { abi: artifact.abi, bytecode: artifact.evm.bytecode.object };
  }
  return out;
}

export async function deployMock(
  deployer: Signer,
  name: "MockShieldPauseController" | "MockConfigurableFeeModule"
): Promise<DeployedMock> {
  const compiled = compileMocks();
  const artifact = compiled[name];
  if (!artifact) throw new Error(`mock ${name} not found in solc output`);
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer);
  const contract = await factory.deploy();
  await contract.waitForDeployment();
  return { contract: contract as unknown as Contract, address: await contract.getAddress() };
}
