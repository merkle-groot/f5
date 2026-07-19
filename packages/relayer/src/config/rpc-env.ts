import { ConfigError } from "../exceptions/base.exception.js";

type Environment = Record<string, string | undefined>;
type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function envKeyPart(value: unknown): string {
  return String(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_");
}

export function chainRpcEnvName(chainId: unknown): string {
  return `CHAIN_${envKeyPart(chainId)}_RPC_URL`;
}

export function destinationRpcEnvName(key: unknown): string {
  return `DESTINATION_${envKeyPart(key)}_RPC_URL`;
}

function rpcUrlFromEnv(
  entry: JsonObject,
  envName: string,
  location: string,
  env: Environment,
): string {
  if (Object.hasOwn(entry, "rpc_url")) {
    throw new ConfigError(
      `${location}.rpc_url must not be stored in the JSON config. Remove it and set ${envName} in .env.`,
    );
  }

  const value = env[envName]?.trim();
  if (!value) {
    throw new ConfigError(
      `Missing required RPC environment variable ${envName}.`,
    );
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${envName} must be a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`${envName} must use http:// or https://.`);
  }
  return value;
}

/**
 * Adds runtime-only RPC URLs to the parsed JSON shape before Zod validation.
 *
 * RPC endpoints can contain provider credentials, so the JSON config is forbidden from
 * carrying them. Source chains are keyed by numeric chain id; destinations are keyed by their
 * stable string key.
 */
export function injectRpcUrlsFromEnv(
  input: unknown,
  env: Environment = process.env,
): unknown {
  if (!isObject(input)) return input;

  const chains = Array.isArray(input.chains)
    ? input.chains.map((value, index) => {
        if (!isObject(value)) return value;
        const envName = chainRpcEnvName(value.chain_id);
        return {
          ...value,
          rpc_url: rpcUrlFromEnv(value, envName, `chains[${index}]`, env),
        };
      })
    : input.chains;

  const destinations = Array.isArray(input.destinations)
    ? input.destinations.map((value, index) => {
        if (!isObject(value)) return value;
        const envName = destinationRpcEnvName(value.key);
        return {
          ...value,
          rpc_url: rpcUrlFromEnv(value, envName, `destinations[${index}]`, env),
        };
      })
    : input.destinations;

  return { ...input, chains, destinations };
}
