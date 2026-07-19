// MUST be the first import. `config/index.ts` reads CONFIG_PATH at module-evaluation time (not
// inside a function), and it is pulled in transitively by `./app.js` below — so loading .env any
// later means the config file is chosen before .env exists. ESM evaluates imports in declaration
// order, which is what makes this work.
import "dotenv/config";

import { app } from "./app.js";
import { db } from "./providers/db.provider.js";
import { testnetAspService } from "./services/index.js";

const port = Number(process.env.PORT ?? 8788);
const host = process.env.HOST ?? '0.0.0.0';

async function main() {
  await db.init();
  testnetAspService.start();
  // No activation poller here by design: the app server scans and nominates, the
  // relayer verifies and signs. One poller, one place.
  // Start the server
  app.listen(port, host, () => {
    console.log(`Relay API listening at http://${host}:${port}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
