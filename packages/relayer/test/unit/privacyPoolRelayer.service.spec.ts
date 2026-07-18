/**
 * Service-level tests for the Mode-3 relay flow. Unlike a mock-of-the-thing,
 * these drive the REAL `PrivacyPoolRelayer.handleRequest` / `validateWithdrawal`
 * with the REAL `utils` (`parseSignals`, `decode/encodeWithdrawalData`), so the
 * 10-signal `withdrawL1` layout and the `RelayData` (5-field) round-trip get
 * genuine coverage. Only the outward dependencies — config, providers (db + SDK
 * + web3 + uniswap), and the quote service — are mocked.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { getAddress, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Groth16Proof } from "snarkjs";
import { WITHDRAW_L1_SIGNALS } from "@0xbow/privacy-pools-core-sdk";

// Shared mutable mocks (hoisted so the vi.mock factories can close over them).
const h = vi.hoisted(() => ({
  sdk: {
    calculateContext: vi.fn(),
    scopeData: vi.fn(),
    verifyWithdrawal: vi.fn(),
    broadcastWithdrawal: vi.fn(),
  },
  db: {
    createNewRequest: vi.fn(),
    updateBroadcastedRequest: vi.fn(),
    updateFailedRequest: vi.fn(),
  },
  quote: {
    quoteFeeBPSNative: vi.fn(),
    extraGasTxCost: 320_000n,
  },
  web3: {
    getGasPrice: vi.fn(),
    verifyRelayerCommitment: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
    client: vi.fn(),
    signRelayerCommitment: vi.fn(),
  },
  uniswap: { swapExactInputForWeth: vi.fn() },
  config: {
    getAssetConfig: vi.fn(),
    getFeeReceiverAddress: vi.fn(),
    getSignerPrivateKey: vi.fn(),
  },
}));

vi.mock("../../src/config/index.js", () => ({
  getAssetConfig: h.config.getAssetConfig,
  getFeeReceiverAddress: h.config.getFeeReceiverAddress,
  getSignerPrivateKey: h.config.getSignerPrivateKey,
}));

vi.mock("../../src/providers/index.js", () => ({
  db: h.db,
  SdkProvider: vi.fn(() => h.sdk),
  web3Provider: h.web3,
  uniswapProvider: h.uniswap,
  UniswapProvider: vi.fn(() => h.uniswap),
}));

vi.mock("../../src/services/index.js", () => ({
  quoteService: h.quote,
}));

// REAL utils (not mocked) — this is the point of the file.
import { decodeWithdrawalData, encodeWithdrawalData } from "../../src/utils.js";
import { PrivacyPoolRelayer } from "../../src/services/privacyPoolRelayer.service.js";
import { WithdrawalPayload } from "../../src/interfaces/relayer/request.js";

const SIGNER_PK =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const SIGNER_ADDRESS = privateKeyToAccount(SIGNER_PK).address;
const FEE_RECEIVER = getAddress("0x1212121212121212121212121212121212121212");
const RECIPIENT = getAddress("0xe1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1");
const ASSET = getAddress("0x1111111111111111111111111111111111111111");
const POOL = getAddress("0x0000000000000000000000000000000000000001");
const DEST_CHAIN = 11155420n;
const SOURCE_CHAIN = 31337;
// context: mock returns hex, proof signal carries the same value as a decimal.
const CONTEXT_HEX = "0x2a";
const CONTEXT_DEC = "42";

/** Build a valid `RelayData` blob with the real encoder. */
function relayData(overrides: {
  recipient?: Hex;
  feeRecipient?: Hex;
  relayFeeBPS?: bigint;
} = {}): Hex {
  return encodeWithdrawalData({
    recipient: overrides.recipient ?? RECIPIENT,
    feeRecipient: overrides.feeRecipient ?? FEE_RECEIVER,
    ephemeralKey: [111n, 222n],
    viewTag: "0x07",
    relayFeeBPS: overrides.relayFeeBPS ?? 1000n,
  });
}

/**
 * Build the 10 `withdrawL1` public signals by NAME, placing each at the index
 * the circuit assigned it. Writing the array out positionally is what let the
 * fixture drift from the circuit before — it agreed with a `parseSignals` that
 * was itself wrong, so these tests passed while every real relay reverted.
 * `WITHDRAW_L1_SIGNALS` is pinned to the circuit artifact by the SDK's
 * `withdrawalSignals.spec.ts`.
 */
function signals(withdrawnValue: string, context = CONTEXT_DEC, relayFeeBPS = 1000n): string[] {
  const gross = BigInt(withdrawnValue);
  const bridged = gross - ((gross * relayFeeBPS) / 10_000n);

  const out = new Array<string>(Object.keys(WITHDRAW_L1_SIGNALS).length).fill("0");
  out[WITHDRAW_L1_SIGNALS.withdrawnValue] = withdrawnValue;
  out[WITHDRAW_L1_SIGNALS.bridgedValue] = bridged.toString();
  out[WITHDRAW_L1_SIGNALS.context] = context;
  return out;
}

function payload(over: {
  chainId?: bigint;
  data?: Hex;
  publicSignals?: string[];
  scope?: bigint;
  feeCommitment?: WithdrawalPayload["feeCommitment"];
}): WithdrawalPayload {
  const data = over.data ?? relayData();
  const { relayFeeBPS } = decodeWithdrawalData(data);
  return {
    withdrawal: {
      chainId: over.chainId ?? DEST_CHAIN,
      data,
    },
    proof: {
      proof: {
        pi_a: ["0", "0"],
        pi_b: [
          ["0", "0"],
          ["0", "0"],
        ],
        pi_c: ["0", "0"],
        protocol: "groth16",
        curve: "bn128",
      } as unknown as Groth16Proof,
      publicSignals: over.publicSignals ?? signals("5000", CONTEXT_DEC, relayFeeBPS),
    },
    scope: over.scope ?? 0n,
    feeCommitment: over.feeCommitment,
  };
}

describe("PrivacyPoolRelayer (Mode-3, real service)", () => {
  let service: PrivacyPoolRelayer;

  beforeEach(() => {
    vi.clearAllMocks();

    h.config.getFeeReceiverAddress.mockReturnValue(FEE_RECEIVER);
    h.config.getSignerPrivateKey.mockReturnValue(SIGNER_PK);
    h.config.getAssetConfig.mockReturnValue({
      asset_address: ASSET,
      asset_name: "TEST",
      fee_bps: 100n,
      min_withdraw_amount: 200n,
    });

    h.sdk.calculateContext.mockReturnValue(CONTEXT_HEX);
    h.sdk.scopeData.mockResolvedValue({ assetAddress: ASSET, poolAddress: POOL });
    h.sdk.verifyWithdrawal.mockResolvedValue(true);
    h.sdk.broadcastWithdrawal.mockResolvedValue({ hash: "0xTx" });

    // quoted fee below the request's relayFeeBPS (1000) so the fee check passes
    h.quote.quoteFeeBPSNative.mockResolvedValue({ feeBPS: 500n, gasPrice: 1n });
    h.web3.verifyRelayerCommitment.mockResolvedValue(true);

    service = new PrivacyPoolRelayer();
  });

  it("relays when every check passes (real decode + parseSignals)", async () => {
    const res = await service.handleRequest(payload({}), SOURCE_CHAIN);

    expect(res.success).toBe(true);
    expect(res.txHash).toBe("0xTx");
    // context was computed over the relay shape {chainId, data}
    expect(h.sdk.calculateContext).toHaveBeenCalledWith(
      { chainId: DEST_CHAIN, data: expect.any(String) },
      0n,
    );
    expect(h.sdk.broadcastWithdrawal).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid destination chainId", async () => {
    const res = await service.handleRequest(
      payload({ chainId: 0n }),
      SOURCE_CHAIN,
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain("CHAIN_NOT_SUPPORTED");
    expect(h.sdk.broadcastWithdrawal).not.toHaveBeenCalled();
  });

  it("rejects when the fee recipient is not the relayer's", async () => {
    const data = relayData({
      feeRecipient: getAddress("0x2222222222222222222222222222222222222222"),
    });
    const res = await service.handleRequest(payload({ data }), SOURCE_CHAIN);
    expect(res.success).toBe(false);
    expect(res.error).toContain("FEE_RECEIVER_MISMATCH");
  });

  it("rejects when the proof context does not match the request", async () => {
    // proof carries a different context than calculateContext returns (0x2a=42)
    const res = await service.handleRequest(
      payload({ publicSignals: signals("5000", "99") }),
      SOURCE_CHAIN,
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain("CONTEXT_MISMATCH");
  });

  it("rejects when the relay fee is below the current quote", async () => {
    h.quote.quoteFeeBPSNative.mockResolvedValue({ feeBPS: 2000n, gasPrice: 1n });
    const data = relayData({ relayFeeBPS: 100n }); // < 2000
    const res = await service.handleRequest(payload({ data }), SOURCE_CHAIN);
    expect(res.success).toBe(false);
    expect(res.error).toContain("FEE_TOO_LOW");
  });

  it("rejects a withdrawn value below the asset minimum", async () => {
    const res = await service.handleRequest(
      payload({ publicSignals: signals("100") }), // min is 200
      SOURCE_CHAIN,
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain("INSUFFICIENT_WITHDRAWN_VALUE");
  });

  it("rejects when the SDK fails to verify the proof", async () => {
    h.sdk.verifyWithdrawal.mockResolvedValue(false);
    const res = await service.handleRequest(payload({}), SOURCE_CHAIN);
    expect(res.success).toBe(false);
    expect(res.error).toContain("INVALID_PROOF");
    expect(h.sdk.broadcastWithdrawal).not.toHaveBeenCalled();
  });

  it("uses the real 10-signal layout: value at [3], bridged value at [4], context at [9]", async () => {
    // A value at index [2] (existingNullifierHash) must NOT be read as
    // withdrawnValue: put a large number there but a below-min value at the real
    // withdrawnValue index, and expect rejection.
    const s = signals("100");
    s[WITHDRAW_L1_SIGNALS.existingNullifierHash] = "999999999";
    const res = await service.handleRequest(
      payload({ publicSignals: s }),
      SOURCE_CHAIN,
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain("INSUFFICIENT_WITHDRAWN_VALUE");
  });

  it("keeps the signer address available for the extra-gas path", () => {
    // sanity: the fixed test key resolves (used by isFeeReceiverSameAsSigner)
    expect(SIGNER_ADDRESS).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  describe("Option 2 fee commitment (byte-equal RelayData)", () => {
    it("relays when the signed commitment matches the submitted RelayData", async () => {
      const data = relayData();
      const res = await service.handleRequest(
        payload({
          data,
          feeCommitment: {
            withdrawalData: data, // byte-identical to withdrawal.data
            asset: ASSET,
            expiration: Date.now() + 60_000,
            amount: 200n, // <= withdrawnValue (5000)
            extraGas: false,
            signedRelayerCommitment: "0x",
          },
        }),
        SOURCE_CHAIN,
      );
      expect(res.success).toBe(true);
      expect(h.web3.verifyRelayerCommitment).toHaveBeenCalledTimes(1);
    });

    it("rejects when the commitment data differs from the withdrawal data", async () => {
      const res = await service.handleRequest(
        payload({
          data: relayData(),
          feeCommitment: {
            // different bytes than withdrawal.data (different fee recipient)
            withdrawalData: relayData({
              feeRecipient: getAddress(
                "0x3333333333333333333333333333333333333333",
              ),
            }),
            asset: ASSET,
            expiration: Date.now() + 60_000,
            amount: 200n,
            extraGas: false,
            signedRelayerCommitment: "0x",
          },
        }),
        SOURCE_CHAIN,
      );
      expect(res.success).toBe(false);
      expect(res.error).toContain("RELAYER_COMMITMENT_REJECTED");
      expect(h.sdk.broadcastWithdrawal).not.toHaveBeenCalled();
    });

    it("rejects an expired commitment", async () => {
      const data = relayData();
      const res = await service.handleRequest(
        payload({
          data,
          feeCommitment: {
            withdrawalData: data,
            asset: ASSET,
            expiration: Date.now() - 1, // already expired
            amount: 200n,
            extraGas: false,
            signedRelayerCommitment: "0x",
          },
        }),
        SOURCE_CHAIN,
      );
      expect(res.success).toBe(false);
      expect(res.error).toContain("RELAYER_COMMITMENT_REJECTED");
    });
  });
});
