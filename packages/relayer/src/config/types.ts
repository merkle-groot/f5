import { z } from "zod";
import { 
  zAssetConfig, 
  zChainConfig, 
  zCommonConfig, 
  zDefaultConfig, 
  zConfig,
  zDestination,
  zNativeCurrency
} from "./schemas.js";

// Export types derived from Zod schemas
export type AssetConfig = z.infer<typeof zAssetConfig>;
export type ChainConfig = z.infer<typeof zChainConfig>;
export type DestinationConfig = z.infer<typeof zDestination>;
export type EvmDestinationConfig = Extract<DestinationConfig, { family: "evm" }>;
export type StarknetDestinationConfig = Extract<DestinationConfig, { family: "starknet" }>;
export type NativeCurrency = z.infer<typeof zNativeCurrency>;
export type AspPool = z.infer<typeof import("./schemas.js").zAspPool>;
export type CommonConfig = z.infer<typeof zCommonConfig>;
export type DefaultConfig = z.infer<typeof zDefaultConfig>;
export type Config = z.infer<typeof zConfig>;
