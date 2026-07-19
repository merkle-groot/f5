import { describe, expect, it } from "vitest";
import { buildStarknetWithdrawalCalldata } from "../../src/providers/destination/starknet.destination.js";

describe("buildStarknetWithdrawalCalldata", () => {
  it("keeps Garaga's span length prefix exactly once", () => {
    const calldata = buildStarknetWithdrawalCalldata(
      {
        processooor: "1",
        recipient: "2",
        feeRecipient: "3",
        relayFeeBPS: "4",
      },
      ["3", "11", "22", "33"],
    );

    expect(calldata).toEqual(["1", "2", "3", "4", "0", "3", "11", "22", "33"]);
  });
});
