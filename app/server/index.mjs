/**
 * The app server: a read-only chain indexer and a dumb proxy in front of the relayer.
 *
 * It holds NO private keys and signs NO transactions. Every write — L1 relay, L2
 * activation, L2 withdrawal, on every chain family — is constructed and signed by
 * `packages/relayer`. `grep -rn "PRIVATE_KEY" app/server app/src` should return only
 * comments; `starknet`'s `Account` and viem's `privateKeyToAccount` must never be
 * imported anywhere under `server/`.
 *
 * This file is wiring only. The work lives in:
 *   config.mjs          every environment variable, in one place
 *   pool-events.mjs     event/view definitions and log parsers
 *   evm-reads.mjs       EVM chain reads (L1 + every EVM L2), via the shared index
 *   starknet-reads.mjs  Cairo chain reads
 *   destinations.mjs    activation scanning, and the relayer's signer state
 *   routes/             HTTP surface, one module per area
 */
import "dotenv/config";
import cors from "cors";
import express from "express";
import { fileURLToPath } from "node:url";
import { port } from "./config.mjs";
import { automaticNoteActivator } from "./activator.mjs";
import { l1Router } from "./routes/l1.mjs";
import { l2Router } from "./routes/l2.mjs";
import { miscRouter } from "./routes/misc.mjs";
import { starknetRouter } from "./routes/starknet.mjs";

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(
  "/api/circuits/artifacts",
  express.static(
    fileURLToPath(
      new URL("../../node_modules/@0xbow/privacy-pools-core-sdk/dist/node/artifacts/", import.meta.url),
    ),
  ),
);

app.use("/api", miscRouter);
app.use("/api", l1Router);
app.use("/api/l2", l2Router);
app.use("/api/starknet", starknetRouter);

app.listen(port(), () => {
  console.log(`F5 API listening on :${port()}`);
  automaticNoteActivator.start();
});
