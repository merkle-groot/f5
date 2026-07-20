/**
 * Every environment variable this process reads, in one place.
 *
 * The app server is configured entirely by environment: there is no config file and,
 * deliberately, no secrets. If a name is read anywhere else in `server/`, it belongs
 * here instead — that is what makes "does this process hold a key?" answerable by
 * reading one short file.
 */

/** Blocks re-scanned on every refresh, so the cursor trails the chain head.
 *
 * Parking the cursor exactly at the head would permanently miss any event that a
 * reorg reshuffles into a block we have already passed.
 */
export const REORG_BUFFER = 16n;

export const MULTICALL3_ADDRESS =
  process.env.MULTICALL3_ADDRESS ?? "0xcA11bde05977b3631167028862bE2a173976CA11";

/** The relayer destination key the Starknet routes forward to. */
export const STARKNET_DESTINATION_KEY = process.env.STARKNET_DESTINATION_KEY ?? "starknet";

export const port = () => Number(process.env.PORT ?? 8787);

/** The L1 pool this app is pointed at. */
export function getL1() {
  return {
    chainId: Number(process.env.CHAIN_ID ?? 1),
    chainName: process.env.CHAIN_NAME ?? "Ethereum mainnet",
    rpcUrl: process.env.PUBLIC_RPC_URL ?? "",
    poolAddress: process.env.POOL_ADDRESS ?? "",
    entrypointAddress: process.env.ENTRYPOINT_ADDRESS ?? "",
    deploymentBlock: BigInt(process.env.DEPLOYMENT_BLOCK ?? "0"),
    asset: process.env.ASSET_ADDRESS ?? "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
    symbol: process.env.ASSET_SYMBOL ?? "ETH",
    decimals: Number(process.env.ASSET_DECIMALS ?? 18),
    scope: process.env.POOL_SCOPE ?? "",
    explorerUrl: explorerUrl(process.env.EXPLORER_URL),
  };
}

/**
 * Normalise a block-explorer origin, or "" when none is set.
 *
 * Explorer links are additive: the client renders one only when this is non-empty,
 * so an unconfigured deployment shows plain text rather than a dead link. The
 * trailing slash is stripped here so callers can join with a literal `/tx/...` —
 * both EVM explorers and the Starknet ones (Voyager, Starkscan) use that path.
 */
function explorerUrl(value) {
  const trimmed = String(value ?? "").trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(trimmed) ? trimmed : "";
}

/** True when we know enough to index the L1 pool at all. */
export const l1Indexable = () => {
  const l1 = getL1();
  return Boolean(l1.rpcUrl && l1.poolAddress);
};

/**
 * The configured EVM L2 destinations, one per key in `L2_EVM_CHAINS` (e.g. "op,base").
 *
 * Each destination is a distinct Mode-3 pool on its own chain — OP and Base are NOT one generic
 * "L2". Per-chain vars are read by uppercased prefix (`OP_POOL_ADDRESS`, `BASE_RPC_URL`, ...), so a
 * new chain is added by filling a `<KEY>_*` block and appending the key to `L2_EVM_CHAINS`; no code
 * change. A chain missing its RPC or pool is dropped rather than half-configured.
 */
export function getEvmL2s() {
  const keys = (process.env.L2_EVM_CHAINS ?? "op")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  return keys
    .map((key) => {
      const P = key.toUpperCase();
      return {
        key,
        chainId: Number(process.env[`${P}_CHAIN_ID`] ?? 0),
        chainName: process.env[`${P}_CHAIN_NAME`] ?? key,
        rpcUrl: process.env[`${P}_RPC_URL`] ?? "",
        poolAddress: process.env[`${P}_POOL_ADDRESS`] ?? "",
        deploymentBlock: process.env[`${P}_DEPLOYMENT_BLOCK`] ?? "0",
        blockTimeMs: Number(process.env[`${P}_BLOCK_TIME_MS`] ?? 2_000),
        explorerUrl: explorerUrl(process.env[`${P}_EXPLORER_URL`]),
        // No signing key. Whether a destination can be signed for is reported by the
        // relayer via `/relayer/destinations/:key`, never inferred from local state.
      };
    })
    .filter((c) => c.rpcUrl && c.poolAddress);
}

/** Resolve one EVM L2 by its `:chain` route param, or throw a 404-shaped error. */
export function requireEvmL2(key) {
  const chain = getEvmL2s().find((c) => c.key === String(key).toLowerCase());
  if (!chain) {
    const error = new Error(`EVM L2 "${key}" is not configured`);
    error.status = 404;
    throw error;
  }
  return chain;
}

/**
 * Read-only Starknet settings. The relayer address is reported by the relayer, and
 * the private key is gone entirely — this process cannot sign.
 */
export function getStarknetConfig() {
  return {
    rpcUrl: process.env.STARKNET_RPC_URL ?? "",
    chainId: process.env.STARKNET_CHAIN_ID ?? "393402133025997798000961",
    chainName: process.env.STARKNET_CHAIN_NAME ?? "Starknet Sepolia",
    poolAddress: process.env.STARKNET_POOL_ADDRESS ?? "",
    assetAddress: process.env.STARKNET_ASSET_ADDRESS ?? "",
    deploymentBlock: Number(process.env.STARKNET_DEPLOYMENT_BLOCK ?? 0),
    blockTimeMs: Number(process.env.STARKNET_BLOCK_TIME_MS ?? 30_000),
    explorerUrl: explorerUrl(process.env.STARKNET_EXPLORER_URL),
  };
}

export const starknetConfigured = () => {
  const c = getStarknetConfig();
  return Boolean(c.rpcUrl && c.poolAddress);
};

/** Auto-activation scanning knobs. See `note-activator.mjs` for how they are used. */
export function getScanConfig() {
  const configuredPollMs = Number(process.env.L2_SCAN_POLL_MS ?? 15_000);
  return {
    enabled: process.env.L2_AUTO_ACTIVATE !== "false",
    // One active cadence for every destination. Keeping this independent of block
    // time makes retry latency predictable across EVM chains and Starknet.
    pollMs: Number.isFinite(configuredPollMs) && configuredPollMs > 0
      ? Math.min(Math.max(configuredPollMs, 2_000), 120_000)
      : 15_000,
    // How slowly to scan a destination with nothing pending. This is the single
    // biggest lever on RPC spend: an idle destination polled at block time costs
    // millions of requests a month to learn that nothing happened.
    idlePollMs: Number(process.env.L2_IDLE_POLL_MS ?? 60_000),
    // How long an accepted L1 relay keeps destinations at the fast cadence.
    //
    // OFF by default, and that is a measured decision rather than caution. The app
    // server does not parse relay bodies, so a nudge has to wake EVERY destination;
    // at four destinations a 15-minute window costs more in RPC than the idle
    // polling it replaces (~$114/mo against ~$4/mo at $6/M requests) and buys at most
    // one idle interval of latency on a flow already gated by minutes of bridge
    // settlement. `idlePollMs` discovery plus the pending-notes signal covers it.
    //
    // Set this only if you need sub-`idlePollMs` activation and have priced it.
    activeWindowMs: Number(process.env.L2_ACTIVE_WINDOW_MS ?? 0),
  };
}

export const relayerApiUrl = () => process.env.RELAYER_API_URL ?? "";
