export { PrivacyPoolRelayer } from "./privacyPoolRelayer.service.js";
import { PrivacyPoolRelayer } from "./privacyPoolRelayer.service.js";
import { QuoteService } from "./quote.service.js";
import { DestinationService } from "./destination.service.js";
import { DestinationRegistry } from "../providers/destination/registry.js";

export const privacyPoolRelayer = new PrivacyPoolRelayer();
export const quoteService = new QuoteService();

/**
 * Destination wiring, built on first use rather than at module load.
 *
 * Lazy for the same reason `getSdkProvider()` is: constructing it reads config and
 * builds a client per destination, and importing anything from this barrel (the L1
 * relay handler does) must not drag that in. An L1 relay has to keep working when a
 * destination is misconfigured.
 *
 * The relayer does NOT poll. Discovering activatable notes is the app server's job;
 * the relayer only verifies and signs what it is asked to. One registry is shared by
 * every request so the provider instances (and the executor that serializes their
 * nonces) are shared too.
 */
let _destinationRegistry: DestinationRegistry | undefined;
export function getDestinationRegistry(): DestinationRegistry {
  if (!_destinationRegistry) _destinationRegistry = new DestinationRegistry();
  return _destinationRegistry;
}

let _destinationService: DestinationService | undefined;
export function getDestinationService(): DestinationService {
  if (!_destinationService) _destinationService = new DestinationService(getDestinationRegistry());
  return _destinationService;
}

export { DestinationService } from "./destination.service.js";
export * from "./testnetAsp.service.js";
