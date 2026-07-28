import { Router } from "express";
import {
  destinationActivateHandler,
  destinationDetailsHandler,
  destinationWithdrawHandler,
  listDestinationsHandler,
  relayerDetailsHandler,
  relayQuoteHandler,
  relayRequestHandler,
  testnetAspProofHandler,
} from "../handlers/index.js";
import {
  validateDetailsMiddleware,
  validateQuoteMiddleware,
  validateRelayRequestMiddleware
} from "../middlewares/relayer/request.js";
import { inFlightLimit, rateLimitPerIp } from "../middlewares/throttle.js";

// Load-shedding limits. Env-tunable; defaults chosen to protect a single instance
// without rejecting normal traffic. Instantiated ONCE here so their counters are shared.
const RATE_LIMIT_WINDOW_MS = Number(process.env.RELAYER_RATE_LIMIT_WINDOW_MS ?? 60_000);
const RATE_LIMIT_MAX = Number(process.env.RELAYER_RATE_LIMIT_MAX ?? 60);
// The relay path runs a Groth16 verification, so keep concurrency modest.
const MAX_INFLIGHT_RELAYS = Number(process.env.RELAYER_MAX_INFLIGHT_RELAYS ?? 8);

const relayGate = inFlightLimit(MAX_INFLIGHT_RELAYS);

// Router setup
const relayerRouter = Router();

// Per-IP rate limit across every relayer endpoint (reads included: they hit RPCs).
relayerRouter.use(rateLimitPerIp(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX));

relayerRouter.get("/details", [
  validateDetailsMiddleware,
  relayerDetailsHandler
]);

relayerRouter.post("/request", [
  relayGate,
  validateRelayRequestMiddleware,
  relayRequestHandler,
]);

relayerRouter.post("/quote", [
  validateQuoteMiddleware,
  relayQuoteHandler
]);

relayerRouter.get("/asp/proof/:label", (req, res, next) => { void testnetAspProofHandler(req, res).catch(next); });

// Destination (L2 pool) writes. These were previously signed by the app server; it
// now proxies here so the relayer is the only component holding keys.
relayerRouter.get("/destinations", listDestinationsHandler);
relayerRouter.get("/destinations/:key", destinationDetailsHandler);
relayerRouter.post("/destinations/:key/activate", destinationActivateHandler);
relayerRouter.post("/destinations/:key/withdraw", destinationWithdrawHandler);


export { relayerRouter };
