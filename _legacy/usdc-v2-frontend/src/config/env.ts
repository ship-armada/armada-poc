type EnvKey = `VITE_${string}`

function readEnvVar(key: EnvKey, required = false): string | undefined {
  const value = import.meta.env[key]
  if (required && !value) {
    // TODO: Replace console warn with centralized logging service.
    console.warn(`Missing required environment variable: ${key}`)
  }
  return value
}

export const env = {
  // nobleLcdUrl kept for backward compatibility (fallback when config not available)
  nobleLcdUrl: () => readEnvVar('VITE_NOBLE_LCD_URL'),
  nobleToNamadaChannel: () => readEnvVar('VITE_NOBLE_TO_NAMADA_CHANNEL') || 'channel-136',
  nobleDomainId: () => {
    const domainId = readEnvVar('VITE_NOBLE_DOMAIN_ID')
    return domainId ? Number.parseInt(domainId, 10) : 4
  },
  namadaRpc: () => readEnvVar('VITE_NAMADA_RPC_URL') || readEnvVar('VITE_NAMADA_RPC') || 'https://rpc.siuuu.click',
  namadaChainId: () => readEnvVar('VITE_NAMADA_CHAIN_ID', true),
  namadaToken: () => readEnvVar('VITE_NAMADA_NAM_TOKEN') || 'tnam1q9gr66cvu4hrzm0sd5kmlnjje82gs3xlfg3v6nu7',
  namadaMaspIndexerUrl: () => readEnvVar('VITE_NAMADA_MASP_INDEXER_URL') || 'https://masp.siuuu.click',
  namadaIndexerUrl: () => readEnvVar('VITE_NAMADA_INDEXER_URL') || 'https://indexer.siuuu.click',
  namadaDbName: () => readEnvVar('VITE_NAMADA_DB_NAME') || 'usdcdelivery',
  namadaMaspParamsUrl: () => readEnvVar('VITE_NAMADA_MASP_PARAMS_BASE_URL') || '/masp/',
  sharedWorkerPath: () => readEnvVar('VITE_SHIELDED_WORKER_PATH'),
  usdcTokenAddress: () => readEnvVar('VITE_USDC_TOKEN_ADDRESS'),
  paymentDestinationCaller: () => readEnvVar('VITE_PAYMENT_DESTINATION_CALLER'),
  namadaToNobleChannel: () => readEnvVar('VITE_CHANNEL_ID_ON_NAMADA') || 'channel-27',
  nobleReceiverAddress: () => readEnvVar('VITE_NOBLE_RECEIVER_ADDRESS') || 'noble15xt7kx5mles58vkkfxvf0lq78sw04jajvfgd4d',
  ethUsdPrice: () => {
    const price = readEnvVar('VITE_ETH_USD_PRICE')
    return price ? Number.parseFloat(price) : undefined
  },
  debug: () => readEnvVar('VITE_DEBUG') === 'true' || readEnvVar('VITE_DEBUG') === '1',
  logLevel: () => readEnvVar('VITE_LOG_LEVEL') || 'info',
  irisAttestationBaseUrl: () => readEnvVar('VITE_IRIS_ATTESTATION_BASE_URL') || 'https://iris-api.circle.com/attestations/',
  binanceApiBaseUrl: () => readEnvVar('VITE_BINANCE_API_BASE_URL') || 'https://api.binance.com',
  // Noble forwarding registration config
  nobleRegMinUusdc: () => {
    const value = readEnvVar('VITE_NOBLE_REG_MIN_UUSDC')
    return value ? BigInt(value) : BigInt(20000) // 0.02 USDC default
  },
  nobleRegGasLimit: () => {
    const value = readEnvVar('VITE_NOBLE_REG_GAS_LIMIT')
    return value ? Number.parseInt(value, 10) : 200000
  },
  nobleRegFeeUusdc: () => readEnvVar('VITE_NOBLE_REG_FEE_UUSDC') || '20000', // 0.02 USDC default
}

// TODO: Add typed helpers for chain configs and secret handling once values are defined.
