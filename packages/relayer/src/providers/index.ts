import { Web3Provider } from "./web3.provider.js";
import { UniswapProvider } from "./uniswap/uniswap.provider.js"
import { QuoteProvider } from "./quote.provider.js";
import { SdkProvider } from "./sdk.provider.js";

export { db } from "./db.provider.js";
export { SdkProvider } from "./sdk.provider.js";
export { SqliteDatabase } from "./sqlite.provider.js";
export { UniswapProvider } from "./uniswap/uniswap.provider.js"

export const web3Provider = new Web3Provider();
export const uniswapProvider = new UniswapProvider();
export const quoteProvider = new QuoteProvider();

/**
 * Lazily-initialized shared SDK provider. Constructing it wires a contract
 * instance per configured chain (an RPC-heavy step), so it is created on first
 * use and reused — e.g. by the quote handler to price the fronted L1->L2 bridge fee.
 */
let _sdkProvider: SdkProvider | undefined;
export function getSdkProvider(): SdkProvider {
  if (!_sdkProvider) _sdkProvider = new SdkProvider();
  return _sdkProvider;
}
