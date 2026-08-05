// ABOUTME: Integration seam test — the POC consumes @armada/sdk (git dependency) and its 0zk
// ABOUTME: derivation reproduces the stock-captured keyset vectors (armada-vs-stock differential).

import { expect } from 'chai';
import { readFileSync } from 'fs';
import { join } from 'path';
import { deriveShieldedAddress } from '../../lib/sdk/shielded-identity';

const vectors = JSON.parse(
  readFileSync(join(__dirname, '../../scripts/capture/vectors/keyset-vectors.json'), 'utf8'),
).vectors as Array<{ name: string; rootSecret: string; keyset: { railgunAddress: string } }>;

function hexToBytes(hex: string): Uint8Array {
  const s = hex.replace(/^0x/, '');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

describe('@armada/sdk backend — 0zk derivation parity (git-dep integration seam)', () => {
  for (const v of vectors) {
    it(`${v.name}: armada backend reproduces the stock-captured 0zk address`, async () => {
      const address = await deriveShieldedAddress(hexToBytes(v.rootSecret), 'armada');
      expect(address).to.equal(v.keyset.railgunAddress);
    });
  }

  it('SDK_BACKEND selects the backend; stock path is not wired here yet', async () => {
    let threw = false;
    try {
      await deriveShieldedAddress(new Uint8Array(32).fill(1), 'stock');
    } catch (e) {
      threw = true;
      expect((e as Error).message).to.match(/stock backend not wired/);
    }
    expect(threw).to.equal(true);
  });
});
