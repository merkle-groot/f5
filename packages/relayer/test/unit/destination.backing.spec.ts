import { describe, expect, it } from "vitest";
import { checkActivation } from "../../src/providers/destination/backing.js";
import { ActivationState } from "../../src/providers/destination/types.js";

const state = (overrides: Partial<ActivationState> = {}): ActivationState => ({
  pendingValue: 0n,
  activatedSupply: 0n,
  tokensReceived: 0n,
  ...overrides,
});

describe("checkActivation", () => {
  it("allows a note fully covered by the remaining backing", () => {
    expect(checkActivation(state({ pendingValue: 100n, tokensReceived: 100n }))).toBeNull();
  });

  it("refuses a note the pool never received", () => {
    // pendingValue is also 0 once activated, so both cases land here.
    expect(checkActivation(state({ tokensReceived: 100n }))).toBe("not-pending");
  });

  it("refuses when no tokens have bridged yet", () => {
    expect(checkActivation(state({ pendingValue: 100n }))).toBe("unbacked");
  });

  it("refuses when earlier activations consumed the backing", () => {
    expect(
      checkActivation(state({ pendingValue: 80n, activatedSupply: 60n, tokensReceived: 100n })),
    ).toBe("unbacked");
  });

  it("allows a note that exactly exhausts the remaining backing", () => {
    // Mirrors the contract's `<=`; an off-by-one here would strand a fully backed note.
    expect(
      checkActivation(state({ pendingValue: 40n, activatedSupply: 60n, tokensReceived: 100n })),
    ).toBeNull();
  });

  it("refuses a note one wei beyond the backing", () => {
    expect(
      checkActivation(state({ pendingValue: 41n, activatedSupply: 60n, tokensReceived: 100n })),
    ).toBe("unbacked");
  });
});
