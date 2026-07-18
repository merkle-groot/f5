import { LeanIMT } from "@zk-kit/lean-imt";
import { poseidon } from "maci-crypto/build/ts/hashing.js";
import { keccak256, parseAbiItem, stringToHex } from "viem";
import { CONFIG } from "../config/index.js";
import { web3Provider } from "../providers/index.js";

const depositedEvent = parseAbiItem(
  "event Deposited(address indexed _depositor, uint256 _commitment, uint256 _label, uint256 _value, uint256 _merkleRoot)",
);
const entrypointAbi = [{
  type: "function", name: "latestRoot", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }],
}, {
  type: "function", name: "updateRoot", stateMutability: "nonpayable", inputs: [
    { name: "_root", type: "uint256" }, { name: "_ipfsCID", type: "string" },
  ], outputs: [{ type: "uint256" }],
}, {
  type: "function", name: "hasRole", stateMutability: "view", inputs: [
    { name: "role", type: "bytes32" }, { name: "account", type: "address" },
  ], outputs: [{ type: "bool" }],
}] as const;

const aspPostmanRole = keccak256(stringToHex("ASP_POSTMAN"));

/**
 * Blocks per `eth_getLogs` window.
 *
 * Public RPCs cap the range (Infura rejects >10k with "range N exceeds limit of 10000"). Sweeping
 * a pool's whole history in one call is a time bomb: it works right after deploy, then fails
 * forever once the chain advances past the cap — taking every ASP proof, and so every withdrawal,
 * down with it. Chunk instead.
 */
const LOG_CHUNK_BLOCKS = BigInt(process.env.LOG_CHUNK_BLOCKS ?? "9000");

/**
 * Blocks re-scanned on every refresh. The cursor must trail the chain head: parking it exactly at
 * the head would permanently miss any event a reorg reshuffles into a block we already passed.
 */
const REORG_BUFFER = 16n;

/** One `Deposited` window. Also the source of the cached log type, so `args` survives inference. */
function fetchDeposited(
  client: ReturnType<typeof web3Provider.client>,
  address: `0x${string}`,
  fromBlock: bigint,
  toBlock: bigint,
) {
  return client.getLogs({ address, event: depositedEvent, fromBlock, toBlock });
}
type DepositedLogs = Awaited<ReturnType<typeof fetchDeposited>>;

/** Split [fromBlock, head] into windows the RPC will actually accept. */
function blockRanges(fromBlock: bigint, head: bigint) {
  const ranges: { fromBlock: bigint; toBlock: bigint }[] = [];
  for (let start = fromBlock; start <= head; start += LOG_CHUNK_BLOCKS + 1n) {
    ranges.push({ fromBlock: start, toBlock: start + LOG_CHUNK_BLOCKS > head ? head : start + LOG_CHUNK_BLOCKS });
  }
  return ranges;
}

/**
 * Retry a transient RPC failure with backoff.
 *
 * Public nodes answer `-32603 service temporarily unavailable` under load. This poller is the only
 * source of ASP proofs, and an ASP proof gates every withdrawal — so a momentary blip must degrade
 * into a retry, never into a failed refresh (and certainly never into a dead process).
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
  throw lastError;
}

export type AspProof = { root: string; depth: number; proof: { index: number; siblings: string[]; root: string } };

/** Testnet-only ASP: mirrors every configured pool's deposit labels into Entrypoint. */
export class TestnetAspService {
  private readonly enabled = process.env.TESTNET_ASP_MODE === "true";
  private readonly trees = new Map<number, LeanIMT<bigint>>();
  private refreshing = new Map<number, Promise<void>>();
  /** Per-chain incremental log cache: the accumulated logs plus each pool's scan cursor. */
  private readonly logCache = new Map<number, { logs: DepositedLogs; cursors: Map<string, bigint> }>();

  isEnabled() { return this.enabled; }

  start() {
    if (!this.enabled) return;
    const interval = Number(process.env.TESTNET_ASP_POLL_MS ?? 10_000);
    // A rejected refresh must not become an unhandled rejection: this runs detached from any
    // request, so Node would take the whole relayer down over one transient RPC blip. Log and
    // let the next tick retry.
    const tick = () => {
      for (const chain of CONFIG.chains) {
        this.refresh(chain.chain_id).catch((error) => {
          console.warn(`[testnet-asp] refresh failed for chain ${chain.chain_id}:`, error instanceof Error ? error.message : error);
        });
      }
    };
    tick();
    setInterval(tick, interval);
  }

  async refresh(chainId: number): Promise<void> {
    if (!this.enabled) return;
    const existing = this.refreshing.get(chainId);
    if (existing) return existing;
    const work = this.refreshInternal(chainId).finally(() => this.refreshing.delete(chainId));
    this.refreshing.set(chainId, work);
    return work;
  }

  private async refreshInternal(chainId: number) {
    const chain = CONFIG.chains.find((item) => item.chain_id === chainId);
    if (!chain || chain.asp_pools.length === 0 || !chain.entrypoint_address) return;
    const client = web3Provider.client(chainId);
    const head = await withRetry(() => client.getBlockNumber());

    // Incremental: this poller runs every 10s, and re-sweeping each pool's whole history every
    // tick is a request storm against a rate-limited node (and how we hit "service temporarily
    // unavailable"). Keep the logs and only fetch forward from each pool's own cursor.
    let entry = this.logCache.get(chainId);
    if (!entry) {
      entry = { logs: [], cursors: new Map() };
      this.logCache.set(chainId, entry);
    }
    const seen = new Set(entry.logs.map((log) => `${log.transactionHash}:${log.logIndex}`));

    for (const pool of chain.asp_pools) {
      const poolKey = pool.pool_address.toLowerCase();
      const fromBlock = entry.cursors.get(poolKey) ?? pool.start_block;
      // Deliberately serial: firing every window at once trips public-RPC rate limits.
      for (const range of blockRanges(fromBlock, head)) {
        const fresh = await withRetry(() => fetchDeposited(client, pool.pool_address, range.fromBlock, range.toBlock));
        // The trailing reorg window is re-scanned each tick, so logs repeat.
        for (const log of fresh) {
          const id = `${log.transactionHash}:${log.logIndex}`;
          if (seen.has(id)) continue;
          seen.add(id);
          entry.logs.push(log);
        }
      }
      // Trail the head: parking the cursor at it would permanently miss anything a reorg
      // reshuffles into a block we already passed.
      const next = head > REORG_BUFFER ? head - REORG_BUFFER : 0n;
      entry.cursors.set(poolKey, next > fromBlock ? next : fromBlock);
    }

    const logs = [...entry.logs].sort((a, b) =>
      Number(a.blockNumber - b.blockNumber) || Number((a.logIndex ?? 0) - (b.logIndex ?? 0)));
    const labels = logs.map((log) => log.args._label).filter((label): label is bigint => label !== undefined);
    if (labels.length === 0) return;
    const tree = new LeanIMT((left, right) => poseidon([left, right]));
    tree.insertMany(labels);
    this.trees.set(chainId, tree);
    // A newly deployed Entrypoint has no ASP association set yet. In that
    // state latestRoot() intentionally reverts, so treat it as an empty root
    // and publish the first testnet root below.
    let currentRoot: bigint | undefined;
    try {
      currentRoot = await web3Provider.client(chainId).readContract({
        address: chain.entrypoint_address,
        abi: entrypointAbi,
        functionName: "latestRoot",
      });
    } catch (error) {
      console.warn(`[testnet-asp] no existing ASP root on chain ${chainId}; publishing the first root`);
    }
    if (currentRoot === tree.root) return;
    const cid = process.env.TESTNET_ASP_IPFS_CID ?? "testnet-asp-root-all-labels-placeholder";
    const signer = web3Provider.signers[chainId]!.account!;
    const balance = await web3Provider.client(chainId).getBalance({ address: signer.address });
    if (balance === 0n) {
      console.error(`[testnet-asp] cannot publish chain ${chainId} root: signer ${signer.address} has zero native balance`);
      return;
    }
    const authorized = await web3Provider.client(chainId).readContract({
      address: chain.entrypoint_address,
      abi: entrypointAbi,
      functionName: "hasRole",
      args: [aspPostmanRole, signer.address],
    });
    if (!authorized) {
      console.error(`[testnet-asp] cannot publish chain ${chainId} root: signer ${signer.address} lacks ASP_POSTMAN role`);
      return;
    }
    try {
      const hash = await web3Provider.signer(chainId).writeContract({ chain: web3Provider.chains[chainId]!, account: signer, address: chain.entrypoint_address, abi: entrypointAbi, functionName: "updateRoot", args: [tree.root, cid] });
      await web3Provider.client(chainId).waitForTransactionReceipt({ hash });
      console.log(`[testnet-asp] updated chain ${chainId} root to ${tree.root} (${labels.length} labels), tx ${hash}`);
    } catch (error) {
      console.error(`[testnet-asp] failed to publish chain ${chainId} root:`, error instanceof Error ? error.message : error);
    }
  }

  async proof(chainId: number, label: bigint): Promise<AspProof> {
    await this.refresh(chainId);
    const tree = this.trees.get(chainId);
    if (!tree) throw new Error(`No ASP labels available for chain ${chainId}`);
    const index = tree.indexOf(label);
    if (index < 0) throw new Error("Label is not in the testnet ASP set");
    const proof = tree.generateProof(index);
    return { root: proof.root.toString(), depth: tree.depth, proof: { index: proof.index, siblings: proof.siblings.map(String), root: proof.root.toString() } };
  }
}

export const testnetAspService = new TestnetAspService();
