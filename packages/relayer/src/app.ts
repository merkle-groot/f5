import bodyParser from "body-parser";
import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import {
  errorHandlerMiddleware,
  marshalResponseMiddleware,
  notFoundMiddleware,
} from "./middlewares/index.js";
import { relayerRouter } from "./routes/index.js";
import { CORS_ALLOW_ALL, ALLOWED_DOMAINS } from "./config/index.js";

// Initialize the express app
const app = express();

// Proxy trust governs what `req.ip` resolves to, which is what the per-IP rate limit
// keys on. Off by default (`req.ip` = socket peer). When the relayer sits behind a
// reverse proxy, set RELAYER_TRUST_PROXY so X-Forwarded-For is honoured and callers
// are limited individually rather than sharing the proxy's single bucket. Value is
// passed through to Express: "true"/"false", a hop count, or a subnet/IP list.
const trustProxy = process.env.RELAYER_TRUST_PROXY;
if (trustProxy !== undefined && trustProxy !== "") {
  const asNumber = Number(trustProxy);
  app.set(
    "trust proxy",
    trustProxy === "true"
      ? true
      : trustProxy === "false"
        ? false
        : Number.isInteger(asNumber)
          ? asNumber
          : trustProxy,
  );
}

// Middleware functions
const parseJsonMiddleware = bodyParser.json();

// CORS config - allow all origins by default for development and testnet
const isTestnetRelayer = process.env.NODE_ENV === 'production' && 
  (process.env.RELAYER_HOST === 'testnet-relayer.privacypools.com' || 
   process.env.HOST === 'testnet-relayer.privacypools.com');

const shouldAllowAll = CORS_ALLOW_ALL || isTestnetRelayer;

const corsOptions = {
  origin: shouldAllowAll ? '*' : function (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
    // Allow requests without origin (like mobile apps) or from allowed domains
    if (!origin || ALLOWED_DOMAINS.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.log(`Request blocked by CORS middleware: ${origin}. Allowed domains: ${ALLOWED_DOMAINS}`);
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200
};


// Apply middleware and routes
app.use(cors(corsOptions));
app.use(parseJsonMiddleware);
app.use(marshalResponseMiddleware);

// ping route
app.use("/ping", (req: Request, res: Response, next: NextFunction) => {
  res.send("pong");
  next();
});

// relayer route
app.use("/relayer", relayerRouter);

// Error and 404 handling
app.use([errorHandlerMiddleware, notFoundMiddleware]);

export { app };
