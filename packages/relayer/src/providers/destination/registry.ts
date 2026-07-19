import { getDestinationSignerKey, listDestinations } from "../../config/index.js";
import { ConfigError } from "../../exceptions/base.exception.js";
import { KeyedSerialExecutor } from "../../utils/keyedSerialExecutor.js";
import { EvmDestinationProvider } from "./evm.destination.js";
import { StarknetDestinationProvider } from "./starknet.destination.js";
import { DestinationProvider } from "./types.js";

/**
 * All configured destination pools, built once at startup.
 *
 * One executor is shared across every provider so that serialization is per signer
 * (the executor's key), not per provider instance — two providers pointed at the same
 * chain and key must not each think they own the nonce.
 */
export class DestinationRegistry {
  private readonly providers = new Map<string, DestinationProvider>();

  constructor(queue: KeyedSerialExecutor = new KeyedSerialExecutor()) {
    for (const config of listDestinations()) {
      try {
        const signerKey = getDestinationSignerKey(config.key);
        const provider =
          config.family === "evm"
            ? new EvmDestinationProvider(config, signerKey, queue)
            : new StarknetDestinationProvider(config, signerKey, queue);
        this.providers.set(config.key.toLowerCase(), provider);

        if (!signerKey) {
          console.warn(
            `[DESTINATION] "${config.key}" (${config.chain_name}) has no signer key; reads only.`,
          );
        }
      } catch (error) {
        // Skip rather than throw: one malformed destination must not stop the
        // relayer from serving L1 relays and its other destinations.
        console.error(
          `[DESTINATION] failed to initialise "${config.key}":`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  get(key: string): DestinationProvider {
    const provider = this.providers.get(String(key).toLowerCase());
    if (!provider) {
      throw ConfigError.unknownDestination(
        `Destination "${key}" is not configured. Known destinations: ${
          [...this.providers.keys()].join(", ") || "(none)"
        }.`,
      );
    }
    return provider;
  }

  list(): DestinationProvider[] {
    return [...this.providers.values()];
  }
}
