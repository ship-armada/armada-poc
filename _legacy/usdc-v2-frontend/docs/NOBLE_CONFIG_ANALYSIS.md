# Noble Configuration Analysis

## Summary

Investigation of Noble configuration duplication and usage patterns.

## 1. RPC URL Duplication

### Current State

**Environment Variable (`.env.local`):**
```bash
VITE_NOBLE_RPC=https://noble-testnet-rpc.polkachu.com
```

**JSON Config (`tendermint-chains.json`):**
```json
{
  "key": "noble-testnet",
  "rpcUrls": ["https://noble-testnet-rpc.polkachu.com"]
}
```

### Usage Analysis

**`VITE_NOBLE_RPC` (env variable):**
- ✅ Defined in `src/config/env.ts` as `env.nobleRpc()`
- ❌ **NOT USED ANYWHERE** in the codebase
- This is **dead code** - can be safely removed

**`tendermint-chains.json` RPC URL:**
- ✅ Used by `getTendermintRpcUrl('noble-testnet')` function
- ✅ Used in:
  - `src/services/polling/noblePoller.ts` (line 1168)
  - `src/services/noble/nobleLcdClient.ts` (line 207) - for transaction broadcasting
  - `src/services/polling/namadaPoller.ts` (line 498) - for Namada RPC
  - `src/services/polling/tendermintRpcClient.ts` (line 399-408)

### Conclusion

**`VITE_NOBLE_RPC` is completely unused** and should be removed. The application exclusively uses the RPC URL from `tendermint-chains.json` via the `getTendermintRpcUrl()` function.

---

## 2. Other Noble Environment Variables

### Currently Used Variables

| Variable | Used In | Purpose |
|----------|---------|---------|
| `VITE_NOBLE_LCD_URL` | `nobleLcdClient.ts`, `nobleForwardingService.ts` | LCD API endpoint for queries |
| `VITE_NOBLE_TO_NAMADA_CHANNEL` | `nobleForwardingService.ts`, `nobleForwardingRegistration.ts` | IBC channel ID |
| `VITE_NOBLE_DOMAIN_ID` | `txBuilder.ts` | CCTP domain ID for deposits |
| `VITE_NOBLE_RECEIVER_ADDRESS` | `paymentService.ts` | Default receiver address |
| `VITE_NOBLE_REG_MIN_UUSDC` | `nobleForwardingRegistration.ts` | Min balance for registration |
| `VITE_NOBLE_REG_GAS_LIMIT` | `nobleForwardingRegistration.ts` | Gas limit for registration tx |
| `VITE_NOBLE_REG_FEE_UUSDC` | `nobleForwardingRegistration.ts` | Fee for registration tx |

### Should These Move to `tendermint-chains.json`?

#### Arguments FOR Moving:

1. **Consistency**: RPC URL is already in JSON config, other chain configs should be too
2. **Centralization**: All Noble chain config in one place
3. **Version Control**: JSON config is in git, easier to track changes
4. **Multi-chain Support**: Easier to support multiple Noble networks (mainnet/testnet)

#### Arguments AGAINST Moving:

1. **Different Use Cases**:
   - **RPC URL**: Used for polling/querying chain state (runtime config)
   - **LCD URL**: Used for REST API queries (runtime config)
   - **Channel ID**: IBC-specific, not chain-specific (could be per-channel config)
   - **Domain ID**: CCTP-specific, not chain-specific (could be per-domain config)
   - **Registration Config**: Application-level business logic, not chain config

2. **Sensitivity**:
   - Some values might be environment-specific (dev/staging/prod)
   - Environment variables allow per-environment overrides
   - JSON config is public (in public/ folder)

3. **Type of Configuration**:
   - **Chain Config** (belongs in JSON): RPC URLs, chain IDs, explorer URLs, polling timeouts
   - **Application Config** (belongs in env): LCD URLs, channel IDs, domain IDs, business logic params

### Recommendation

**Hybrid Approach:**

1. **Move to `tendermint-chains.json`:**
   - ✅ `lcdUrl` (or `lcdUrls` array) - chain-specific REST API endpoint
   - ✅ `chainId` (already there)
   - ✅ `explorer.baseUrl` (already there)

2. **Keep in Environment Variables:**
   - ✅ `VITE_NOBLE_TO_NAMADA_CHANNEL` - IBC channel config (could be per-channel, not per-chain)
   - ✅ `VITE_NOBLE_DOMAIN_ID` - CCTP domain config (could be per-domain, not per-chain)
   - ✅ `VITE_NOBLE_RECEIVER_ADDRESS` - Application-level default
   - ✅ `VITE_NOBLE_REG_*` - Application-level business logic parameters

3. **Create Separate Config (if needed):**
   - IBC channel mappings (channel-639, channel-136, etc.)
   - CCTP domain mappings (domain 4 for Noble, etc.)
   - Could be in a separate `ibc-config.json` or `cctp-config.json`

---

## 3. Proposed Changes

### Immediate Actions

1. **Remove unused `VITE_NOBLE_RPC` from `.env.local`**
2. **Remove `env.nobleRpc()` from `src/config/env.ts`**

### Future Improvements

1. **Add `lcdUrl` to `tendermint-chains.json`:**
   ```json
   {
     "key": "noble-testnet",
     "rpcUrls": ["https://noble-testnet-rpc.polkachu.com"],
     "lcdUrl": "https://noble-testnet-api.polkachu.com",
     ...
   }
   ```

2. **Update code to use LCD URL from config:**
   - Modify `nobleLcdClient.ts` to read from config
   - Keep env variable as fallback for backward compatibility

3. **Consider separate config files for:**
   - IBC channel mappings
   - CCTP domain mappings
   - Application-level defaults

---

## 4. Files to Modify

### Remove Dead Code:
- `src/config/env.ts` - Remove `nobleRpc()` function
- `.env.local` - Remove `VITE_NOBLE_RPC` line

### Future Refactoring:
- `src/services/noble/nobleLcdClient.ts` - Use LCD URL from config
- `src/services/deposit/nobleForwardingService.ts` - Use LCD URL from config
- `public/tendermint-chains.json` - Add `lcdUrl` field

