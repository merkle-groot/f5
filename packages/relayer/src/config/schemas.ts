import { z } from "zod";
import { getAddress } from "viem";
import path from "node:path";

const zNonNegativeBigInt = z
  .string()
  .or(z.number())
  .pipe(z.coerce.bigint().nonnegative());

// Address validation schema
export const zAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]+/)
  .length(42)
  .transform((v) => getAddress(v));

// Private key validation schema
export const zPkey = z
  .string()
  .regex(/^0x[0-9a-fA-F]+/)
  .length(66)
  .transform((v) => v as `0x${string}`);

// Fee BPS validation schema
export const zFeeBps = z
  .string()
  .or(z.number())
  .pipe(z.coerce.bigint().nonnegative().max(10_000n));

// Withdraw amount validation schema
export const zWithdrawAmount = z
  .string()
  .or(z.number())
  .pipe(z.coerce.bigint().nonnegative());

// Asset configuration schema
export const zAssetConfig = z.object({
  asset_address: zAddress,
  asset_name: z.string(),
  fee_bps: zFeeBps,
  min_withdraw_amount: zWithdrawAmount,
});

export const zAspPool = z.object({
  pool_address: zAddress,
  start_block: zNonNegativeBigInt,
});

// Native currency configuration schema
export const zNativeCurrency = z.object({
  name: z.string().default("Ether"),
  symbol: z.string().default("ETH"),
  decimals: z.number().default(18)
});

// Chain configuration schema
export const zChainConfig = z.object({
  chain_id: z.string().or(z.number()).pipe(z.coerce.number().positive()),
  chain_name: z.string(),
  rpc_url: z.string().url(),
  max_gas_price: zNonNegativeBigInt.optional(),
  fee_receiver_address: zAddress.optional(),
  signer_private_key: zPkey.optional(),
  entrypoint_address: zAddress.optional(),
  supported_assets: z.array(zAssetConfig).optional(),
  asp_pools: z.array(zAspPool).default([]),
  native_currency: zNativeCurrency.optional(),
});

/**
 * A Starknet felt: hex (`0x…`) or decimal, below the 2^251 field bound.
 *
 * Kept as a string rather than a bigint so the value round-trips through the JSON
 * config unchanged; callers coerce at the point of use.
 */
export const zFelt = z
  .string()
  .regex(/^(?:0x[0-9a-fA-F]+|\d+)$/, "must be a hex or decimal felt")
  .refine((v) => BigInt(v) < (1n << 251n), "must be below the felt252 field bound");

/**
 * A destination pool the relayer writes to (`activateNote` / `withdraw`).
 *
 * This is NOT a `zChainConfig`. A chain entry describes where the L1 **entrypoint**
 * lives and is keyed by numeric chain id; a destination describes an L2 **pool** and
 * is keyed by a string (`op`, `base`, `starknet`) because Starknet has no EVM chain
 * id. The two are deliberately separate: conflating them is what would force a felt
 * chain id through `z.coerce.number()`.
 */
export const zDestination = z.discriminatedUnion("family", [
  z.object({
    family: z.literal("evm"),
    key: z.string().min(1),
    chain_id: z.string().or(z.number()).pipe(z.coerce.number().positive()),
    chain_name: z.string(),
    rpc_url: z.string().url(),
    pool_address: zAddress,
    // Optional here for the same reason as `zDefaultConfig.signer_private_key`: the
    // secret belongs in the environment, not in this committed file.
    signer_private_key: zPkey.optional(),
    native_currency: zNativeCurrency.optional(),
  }),
  z.object({
    family: z.literal("starknet"),
    key: z.string().min(1),
    chain_id: zFelt,
    chain_name: z.string(),
    rpc_url: z.string().url(),
    pool_address: zFelt,
    relayer_address: zFelt,
    signer_private_key: zFelt.optional(),
  }),
]);

// Common configuration schema
export const zCommonConfig = z.object({
  sqlite_db_path: z.string().transform((p) => path.resolve(p)),
  cors_allow_all: z.boolean().default(true),
  allowed_domains: z.array(z.string().url()).default(["https://testnet.privacypools.com, https://prod-privacy-pool-ui.vercel.app, https://staging-privacy-pool-ui.vercel.app, https://dev-privacy-pool-ui.vercel.app, http://localhost:3000"]),
});

// Default configuration schema
export const zDefaultConfig = z.object({
  fee_receiver_address: zAddress,
  // Optional so the secret can live in RELAYER_PRIVATE_KEY instead. This file is a normal,
  // committed config — a required key here forces the private key into version control, which is
  // exactly how a live signer key ended up in this repo's history. Env wins; see
  // `getSignerPrivateKey`, which throws if neither source provides one.
  signer_private_key: zPkey.optional(),
  entrypoint_address: zAddress,
});

// Complete configuration schema
export const zConfig = z
  .object({
    defaults: zDefaultConfig,
    chains: z.array(zChainConfig),
    // Defaulted, so every existing config file keeps parsing with no destinations
    // configured — the relayer simply serves no destination writes until one is added.
    destinations: z.array(zDestination).default([]),
    sqlite_db_path: zCommonConfig.shape.sqlite_db_path,
    cors_allow_all: zCommonConfig.shape.cors_allow_all,
    allowed_domains: zCommonConfig.shape.allowed_domains,
  })
  .strict()
  .readonly();
