/**
 * Health, metrics, quote, ASP proof passthrough, and the two proving endpoints.
 *
 * The proving endpoints are the only place the SDK is used server-side, and it is
 * constructed WITHOUT a signer: `createContractInstance` and every write path moved
 * to the relayer.
 */
import { Router } from "express";
import { Circuits, PrivacyPoolSDK } from "@0xbow/privacy-pools-core-sdk";
import { automaticNoteActivator } from "../activator.mjs";
import { getL1, relayerApiUrl } from "../config.mjs";
import { errorMessage } from "../http.mjs";
import { proxyToRelayer } from "../relayer-proxy.mjs";
import { rpcRuntime } from "../rpc-runtime.mjs";

export const miscRouter = Router();

/** Proving only. This SDK instance never gets a private key. */
let sdk;
function getSdk() {
  if (!sdk) sdk = new PrivacyPoolSDK(new Circuits({ browser: false }));
  return sdk;
}

miscRouter.get("/health", (_req, res) => {
  res.json({
    status: "online",
    network: getL1().chainName,
    sdk: "ready",
    // Relaying is configured when we know where the relayer is. Whether it can
    // actually sign is the relayer's own business, reported by /relayer/details.
    relayConfigured: Boolean(relayerApiUrl()),
  });
});

miscRouter.get("/rpc-metrics", (_req, res) => {
  if (process.env.RPC_METRICS_ENABLED !== "true") {
    return res.status(404).json({ error: "RPC metrics are disabled; set RPC_METRICS_ENABLED=true" });
  }
  res.set("cache-control", "no-store");
  return res.json(rpcRuntime.snapshot());
});

miscRouter.get("/quote", (_req, res) => {
  const feeBps = Number(process.env.RELAY_FEE_BPS ?? "30");
  res.json({
    feeBps: feeBps / 100,
    feeLabel: `${feeBps / 100}%`,
    gasCovered: true,
    relayer: process.env.RELAYER_NAME ?? "F5",
  });
});

miscRouter.post(
  "/relayer/quote",
  proxyToRelayer(() => "/relayer/quote", { unavailable: "Relayer quote unavailable" }),
);

miscRouter.post(
  "/relayer/request",
  proxyToRelayer(() => "/relayer/request", {
    unavailable: "Relay request unavailable",
    // An accepted relay means a note is bridging to some destination. Wake the
    // scanner so it catches the arrival at full speed instead of up to one idle
    // interval later. Purely a latency optimisation — see `AutomaticNoteActivator`.
    onSuccess: () => automaticNoteActivator.nudge(),
  }),
);

/**
 * ASP association proofs.
 *
 * Served by a dedicated ASP service when one is configured, otherwise by the
 * relayer's testnet ASP mode. The two speak different URL shapes, which is the whole
 * reason this is not a plain proxy.
 */
miscRouter.get("/asp/proof/:label", async (req, res) => {
  const aspUrl = process.env.ASP_API_URL;
  const provider = aspUrl || relayerApiUrl();
  if (!provider) {
    return res.status(503).json({ error: "ASP_API_URL or RELAYER_API_URL is not configured" });
  }
  const base = provider.replace(/\/$/, "");
  const chainId = encodeURIComponent(String(getL1().chainId));
  const label = encodeURIComponent(req.params.label);
  const endpoint = aspUrl
    ? `${base}/proof?chainId=${chainId}&label=${label}`
    : `${base}/relayer/asp/proof/${label}?chainId=${chainId}`;

  try {
    const response = await fetch(endpoint);
    return res.status(response.status).json(await response.json());
  } catch (error) {
    return res.status(502).json({ error: errorMessage(error, "ASP provider unavailable") });
  }
});

miscRouter.post("/proofs/commitment", async (req, res) => {
  try {
    const { value, label, nullifier, secret } = req.body ?? {};
    if ([value, label, nullifier, secret].some((item) => item === undefined)) {
      return res.status(400).json({ error: "value, label, nullifier and secret are required" });
    }
    const proof = await getSdk().proveCommitment(
      BigInt(value),
      BigInt(label),
      BigInt(nullifier),
      BigInt(secret),
    );
    return res.json({ proof });
  } catch (error) {
    return res.status(500).json({
      error: errorMessage(error, "Commitment proof failed"),
      hint: "Circuit artifacts must be present in the SDK distribution.",
    });
  }
});

miscRouter.post("/proofs/verify", async (req, res) => {
  try {
    return res.json({ valid: await getSdk().verifyCommitment(req.body) });
  } catch (error) {
    return res.status(400).json({ error: errorMessage(error, "Verification failed") });
  }
});
