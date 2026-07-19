import { describe, expect, it } from "vitest";
import {
  chainRpcEnvName,
  destinationRpcEnvName,
  injectRpcUrlsFromEnv,
} from "../../src/config/rpc-env.js";

const config = {
  chains: [{ chain_id: 11155111, chain_name: "Sepolia" }],
  destinations: [
    { family: "evm", key: "op", chain_id: 11155420 },
    { family: "evm", key: "base", chain_id: 84532 },
    { family: "evm", key: "arb", chain_id: 421614 },
    {
      family: "starknet",
      key: "starknet",
      chain_id: "393402133025997798000961",
    },
  ],
};

const env = {
  CHAIN_11155111_RPC_URL: "https://ethereum.example/rpc",
  DESTINATION_OP_RPC_URL: "https://optimism.example/rpc",
  DESTINATION_BASE_RPC_URL: "https://base.example/rpc",
  DESTINATION_ARB_RPC_URL: "https://arbitrum.example/rpc",
  DESTINATION_STARKNET_RPC_URL: "https://starknet.example/rpc",
};

describe("RPC environment configuration", () => {
  it("derives stable variable names from chain ids and destination keys", () => {
    expect(chainRpcEnvName(11155111)).toBe("CHAIN_11155111_RPC_URL");
    expect(destinationRpcEnvName("op-sepolia")).toBe(
      "DESTINATION_OP_SEPOLIA_RPC_URL",
    );
  });

  it("injects every RPC URL from the environment", () => {
    expect(injectRpcUrlsFromEnv(config, env)).toMatchObject({
      chains: [{ rpc_url: env.CHAIN_11155111_RPC_URL }],
      destinations: [
        { rpc_url: env.DESTINATION_OP_RPC_URL },
        { rpc_url: env.DESTINATION_BASE_RPC_URL },
        { rpc_url: env.DESTINATION_ARB_RPC_URL },
        { rpc_url: env.DESTINATION_STARKNET_RPC_URL },
      ],
    });
  });

  it("rejects RPC URLs stored in JSON even when an environment override exists", () => {
    const withJsonRpc = {
      ...config,
      chains: [
        { ...config.chains[0], rpc_url: "https://committed-secret.example" },
      ],
    };
    expect(() => injectRpcUrlsFromEnv(withJsonRpc, env)).toThrow(
      "chains[0].rpc_url must not be stored in the JSON config",
    );
  });

  it("fails clearly when an RPC environment variable is missing", () => {
    expect(() => injectRpcUrlsFromEnv(config, {})).toThrow(
      "Missing required RPC environment variable CHAIN_11155111_RPC_URL",
    );
  });

  it("rejects malformed and non-HTTP RPC URLs", () => {
    expect(() =>
      injectRpcUrlsFromEnv(config, {
        ...env,
        CHAIN_11155111_RPC_URL: "not-a-url",
      }),
    ).toThrow("CHAIN_11155111_RPC_URL must be a valid URL");
    expect(() =>
      injectRpcUrlsFromEnv(config, {
        ...env,
        CHAIN_11155111_RPC_URL: "ws://example.test",
      }),
    ).toThrow("CHAIN_11155111_RPC_URL must use http:// or https://");
  });
});
