import { Circuits, PrivacyPoolSDK, WithdrawalProof } from "@0xbow/privacy-pools-core-sdk";
import { DestinationError, RelayerError, ZkError } from "../exceptions/base.exception.js";
import { db } from "../providers/index.js";
import { checkActivation } from "../providers/destination/backing.js";
import { DestinationRegistry } from "../providers/destination/registry.js";
import {
  DestinationProvider,
  DestinationWithdrawal,
} from "../providers/destination/types.js";
import { RelayerDatabase } from "../types/db.types.js";

export interface DestinationSummary {
  key: string;
  family: "evm" | "starknet";
  chainId: string;
  chainName: string;
  poolAddress: string;
  configured: boolean;
  relayerAddress: string | null;
}

export interface DestinationWriteResponse {
  success: boolean;
  txHash?: string;
  error?: string;
  timestamp: number;
  requestId: string;
}

/**
 * Orchestrates writes to destination (L2) pools.
 *
 * This is the L2 counterpart to `PrivacyPoolRelayer`: same shape (record → validate →
 * verify → broadcast → record outcome), different target. It exists because the app
 * server used to sign these directly, with no validation at all — it broadcast
 * whatever the browser posted.
 */
export class DestinationService {
  private readonly registry: DestinationRegistry;
  private readonly db: RelayerDatabase;
  private readonly sdk: PrivacyPoolSDK;

  constructor(registry: DestinationRegistry = new DestinationRegistry()) {
    this.registry = registry;
    this.db = db;
    this.sdk = new PrivacyPoolSDK(new Circuits({ browser: false }));
  }

  summary(provider: DestinationProvider): DestinationSummary {
    return {
      key: provider.key,
      family: provider.family,
      chainId: provider.chainId,
      chainName: provider.chainName,
      poolAddress: provider.poolAddress,
      configured: provider.signerAddress() !== null,
      relayerAddress: provider.signerAddress(),
    };
  }

  list(): DestinationSummary[] {
    return this.registry.list().map((provider) => this.summary(provider));
  }

  details(key: string): DestinationSummary {
    return this.summary(this.registry.get(key));
  }

  /**
   * Activate a bridged note.
   *
   * The backing check is re-run here against freshly read pool state rather than
   * trusted from the caller: the relayer pays this gas, and an unbacked activation
   * reverts.
   */
  async activate(key: string, commitment: bigint): Promise<DestinationWriteResponse> {
    const provider = this.registry.get(key);
    // Before any RPC work: a destination that cannot sign will never complete this,
    // and reading its chain first would report the RPC's failure instead of the real
    // reason (a misleading 502 "fetch failed" in place of a 503 "no signer").
    this.requireSigner(provider);

    return this.record(`${provider.key}:activate`, { commitment }, async () => {
      // Re-verified against fresh chain state. The app server nominates candidates by
      // scanning, but its view can be stale by the time this lands, and it is not the
      // component that pays for a revert.
      const state = await provider.activationState(commitment);
      const refusal = checkActivation(state);

      if (refusal === "not-pending") {
        throw DestinationError.unbackedActivation(
          `Note ${commitment} is not pending on ${provider.chainName}: it was never received, ` +
            `or it is already activated.`,
        );
      }
      if (refusal === "unbacked") {
        throw DestinationError.unbackedActivation(
          `Note ${commitment} (value ${state.pendingValue}) is not yet backed by bridged tokens ` +
            `on ${provider.chainName}. Activated ${state.activatedSupply} of ${state.tokensReceived} received.`,
        );
      }

      return provider.activateNote(commitment);
    });
  }

  /** Spend an activated note. The proof is verified before any gas is spent. */
  async withdraw(
    key: string,
    withdrawal: DestinationWithdrawal,
    proof: WithdrawalProof,
  ): Promise<DestinationWriteResponse> {
    const provider = this.registry.get(key);
    this.requireSigner(provider);

    return this.record(`${provider.key}:withdraw`, { withdrawal, proof }, async () => {
      if (!(await this.sdk.verifyWithdrawalL2(proof))) {
        throw ZkError.invalidProof({ destination: provider.key });
      }
      return provider.withdraw(withdrawal, proof);
    });
  }

  /**
   * Fail fast on a read-only destination.
   *
   * Throws rather than returning a `success: false` response so it surfaces as a 503
   * through the error middleware: "this destination has no signer" is a configuration
   * fault, not a failed write, and nothing is worth recording in the audit log.
   */
  private requireSigner(provider: DestinationProvider): void {
    if (provider.signerAddress() === null) {
      throw DestinationError.notConfigured(
        `Destination "${provider.key}" (${provider.chainName}) has no signing key; ` +
          `set DESTINATION_${provider.key.toUpperCase()}_PRIVATE_KEY.`,
      );
    }
  }

  /**
   * Run a write with the same record-and-report envelope `PrivacyPoolRelayer` uses:
   * a failure is a `success: false` response, not a thrown error, so the caller
   * always gets a request id it can correlate against the audit log.
   */
  private async record(
    kind: string,
    payload: unknown,
    write: () => Promise<{ hash: string }>,
  ): Promise<DestinationWriteResponse> {
    const requestId = crypto.randomUUID();
    const timestamp = Date.now();

    try {
      await this.db.createDestinationRequest(requestId, timestamp, payload, kind);
      const { hash } = await write();
      await this.db.updateBroadcastedRequest(requestId, hash);
      return { success: true, txHash: hash, timestamp, requestId };
    } catch (error) {
      const message =
        error instanceof RelayerError
          ? error.toPrettyString()
          : error instanceof Error
            ? error.message
            : String(error);
      await this.db.updateFailedRequest(requestId, message);
      return { success: false, error: message, timestamp, requestId };
    }
  }
}
