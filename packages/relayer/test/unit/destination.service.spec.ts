import type { WithdrawalProof } from "@0xbow/privacy-pools-core-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DestinationRegistry } from "../../src/providers/destination/registry.js";
import type {
  DestinationProvider,
  DestinationWithdrawal,
} from "../../src/providers/destination/types.js";

const mocks = vi.hoisted(() => ({
  verifyWithdrawalL2: vi.fn(),
  createDestinationRequest: vi.fn(),
  updateBroadcastedRequest: vi.fn(),
  updateFailedRequest: vi.fn(),
}));

vi.mock("@0xbow/privacy-pools-core-sdk", () => ({
  Circuits: class {},
  PrivacyPoolSDK: class {
    verifyWithdrawalL2 = mocks.verifyWithdrawalL2;
  },
}));

vi.mock("../../src/providers/index.js", () => ({
  db: {
    initialized: true,
    createDestinationRequest: mocks.createDestinationRequest,
    updateBroadcastedRequest: mocks.updateBroadcastedRequest,
    updateFailedRequest: mocks.updateFailedRequest,
  },
}));

vi.mock("../../src/providers/destination/registry.js", () => ({
  DestinationRegistry: class {},
}));

import { DestinationService } from "../../src/services/destination.service.js";

const proof = {} as WithdrawalProof;
const withdrawal = {} as DestinationWithdrawal;

function provider(
  withdraw = vi.fn().mockResolvedValue({ hash: "0xabc" }),
): DestinationProvider {
  return {
    key: "starknet",
    family: "starknet",
    chainId: "0x534e5f5345504f4c4941",
    chainName: "Starknet Sepolia",
    poolAddress: "0x123",
    signerAddress: () => "0x456",
    activateNote: vi.fn(),
    activationState: vi.fn(),
    withdraw,
  };
}

function serviceFor(destination: DestinationProvider): DestinationService {
  const registry = {
    get: vi.fn().mockReturnValue(destination),
    list: vi.fn().mockReturnValue([destination]),
  } as unknown as DestinationRegistry;
  return new DestinationService(registry);
}

describe("DestinationService.withdraw", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createDestinationRequest.mockResolvedValue(undefined);
    mocks.updateBroadcastedRequest.mockResolvedValue(undefined);
    mocks.updateFailedRequest.mockResolvedValue(undefined);
  });

  it("rejects an invalid proof before calldata conversion or broadcast", async () => {
    mocks.verifyWithdrawalL2.mockResolvedValue(false);
    const destination = provider();

    const result = await serviceFor(destination).withdraw(
      "starknet",
      withdrawal,
      proof,
    );

    expect(result.success).toBe(false);
    expect(mocks.verifyWithdrawalL2).toHaveBeenCalledWith(proof);
    expect(destination.withdraw).not.toHaveBeenCalled();
  });

  it("verifies a valid proof before asking the provider to broadcast", async () => {
    const calls: string[] = [];
    mocks.verifyWithdrawalL2.mockImplementation(async () => {
      calls.push("verify");
      return true;
    });
    const destination = provider(
      vi.fn().mockImplementation(async () => {
        calls.push("withdraw");
        return { hash: "0xabc" };
      }),
    );

    const result = await serviceFor(destination).withdraw(
      "starknet",
      withdrawal,
      proof,
    );

    expect(result.success).toBe(true);
    expect(calls).toEqual(["verify", "withdraw"]);
  });
});

describe("DestinationService.activate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createDestinationRequest.mockResolvedValue(undefined);
    mocks.updateBroadcastedRequest.mockResolvedValue(undefined);
    mocks.updateFailedRequest.mockResolvedValue(undefined);
  });

  /**
   * The backing check must run inside the provider's per-signer queue, not before
   * it. Run outside, two activations nominated against the same
   * `tokensReceivedFromBridge` both pass, then serialize, and the second reverts —
   * which is the exact gas waste the check exists to avoid.
   */
  it("verifies backing inside the provider's queue, not before entering it", async () => {
    const destination = provider();
    const activationState = vi
      .fn()
      .mockResolvedValue({ pendingValue: 5n, activatedSupply: 0n, tokensReceived: 5n });
    destination.activationState = activationState;

    let verifyRanInsideQueue = false;
    destination.activateNote = vi.fn().mockImplementation(async (_commitment, verify) => {
      // Nothing may have been read before the provider was handed the work.
      expect(activationState).not.toHaveBeenCalled();
      await verify();
      verifyRanInsideQueue = true;
      return { hash: "0xdef" };
    });

    const result = await serviceFor(destination).activate("starknet", 42n);

    expect(result.success).toBe(true);
    expect(result.txHash).toBe("0xdef");
    expect(verifyRanInsideQueue).toBe(true);
    expect(activationState).toHaveBeenCalledWith(42n);
  });

  it("refuses an unbacked note without broadcasting", async () => {
    const destination = provider();
    destination.activationState = vi
      .fn()
      .mockResolvedValue({ pendingValue: 9n, activatedSupply: 4n, tokensReceived: 5n });
    destination.activateNote = vi.fn().mockImplementation(async (_commitment, verify) => {
      await verify();
      return { hash: "0xdef" };
    });

    const result = await serviceFor(destination).activate("starknet", 42n);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not yet backed/);
    expect(result.txHash).toBeUndefined();
  });

  it("refuses a note the pool never received", async () => {
    const destination = provider();
    destination.activationState = vi
      .fn()
      .mockResolvedValue({ pendingValue: 0n, activatedSupply: 0n, tokensReceived: 100n });
    destination.activateNote = vi.fn().mockImplementation(async (_commitment, verify) => {
      await verify();
      return { hash: "0xdef" };
    });

    const result = await serviceFor(destination).activate("starknet", 42n);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not pending/);
  });
});
