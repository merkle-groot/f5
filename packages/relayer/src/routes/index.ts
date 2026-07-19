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

// Router setup
const relayerRouter = Router();

relayerRouter.get("/details", [
  validateDetailsMiddleware,
  relayerDetailsHandler
]);

relayerRouter.post("/request", [
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
