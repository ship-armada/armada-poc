// One-off live smoke test: shield 1 USDC into the rewritten pool on Sepolia.
// Not committed — proof-of-life for the Phase 4 deploy.
import { ethers } from "hardhat";

const POOL = "0xBbF483F39A3a303777355B2c1A861Cb485587677";
const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("sender:", deployer.address);

  const usdc = await ethers.getContractAt(
    ["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"],
    USDC,
  );
  const pool = await ethers.getContractAt(
    [
      "function shield(((bytes32 npk, (uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value) preimage, (bytes32[3] encryptedBundle, bytes32 shieldKey) ciphertext)[] _shieldRequests, address integrator)",
      "function nextLeafIndex() view returns (uint256)",
      "function merkleRoot() view returns (bytes32)",
    ],
    POOL,
  );

  const balBefore = await usdc.balanceOf(deployer.address);
  const leafBefore = await pool.nextLeafIndex();
  const rootBefore = await pool.merkleRoot();
  console.log(`before: usdc=${balBefore} nextLeafIndex=${leafBefore} root=${rootBefore}`);

  const npk = BigInt(ethers.keccak256(ethers.toUtf8Bytes("armada-sepolia-smoke-npk"))) % FIELD;
  const rand = (s: string) => ethers.keccak256(ethers.toUtf8Bytes("armada-sepolia-smoke:" + s));
  const request = {
    preimage: { npk: ethers.toBeHex(npk, 32), token: { tokenType: 0, tokenAddress: USDC, tokenSubID: 0 }, value: 1_000_000n },
    ciphertext: { encryptedBundle: [rand("b0"), rand("b1"), rand("b2")], shieldKey: rand("sk") },
  };

  const approveTx = await usdc.approve(POOL, 2_000_000n);
  await approveTx.wait();
  console.log("approved pool");

  const tx = await pool.shield([request], ethers.ZeroAddress);
  const receipt = await tx.wait();
  console.log("shield tx:", receipt.hash, "gas:", receipt.gasUsed.toString());

  const balAfter = await usdc.balanceOf(deployer.address);
  const leafAfter = await pool.nextLeafIndex();
  const rootAfter = await pool.merkleRoot();
  console.log(`after:  usdc=${balAfter} nextLeafIndex=${leafAfter} root=${rootAfter}`);

  const shieldEvent = receipt.logs
    .map((l: any) => l.topics?.[0])
    .includes("0x3a5b9dc26075a3801a6ddccf95fec485bb7500a91b44cec1add984c21ee6db3b");
  console.log("Shield event topic present:", shieldEvent);

  const ok =
    balBefore - balAfter === 1_000_000n &&
    leafAfter - leafBefore === 1n &&
    rootAfter !== rootBefore &&
    shieldEvent;
  console.log(ok ? "SMOKE PASS" : "SMOKE FAIL");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
