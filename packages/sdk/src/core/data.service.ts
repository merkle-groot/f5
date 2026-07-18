import {createPublicClient, type Hex, http, parseAbiItem, type PublicClient,} from "viem";
import {mapLimit} from "async";
import {LeanIMT} from "@zk-kit/lean-imt";
import {poseidon} from "maci-crypto/build/ts/hashing.js";
import {ChainConfig, DepositEvent, L2NoteActivatedEvent, L2NoteEvent, L2NoteReceivedEvent, RagequitEvent, WithdrawalEvent,} from "../types/events.js";
import {PoolInfo} from "../types/account.js";
import {Hash} from "../types/commitment.js";
import {ScannableNote} from "../types/stealth.js";
import {BlockRange, ChainLogFetchConfig, DEFAULT_LOG_FETCH_CONFIG, LogFetchConfig,} from "../types/rateLimit.js";
import {Logger, LogLevel} from "../utils/logger.js";
import {DataError} from "../errors/data.error.js";
import {ErrorCode} from "../errors/base.error.js";

// Event signatures from the contract
// NOTE: the 5th field is the PRECOMMITMENT, not a merkle root. It was previously
// named `_merkleRoot` here, which is a lie about the contract's event
// (`IPrivacyPool.Deposited(..., uint256 _precommitmentHash)`). Decoding survived
// only because topic0 hashes param TYPES, not names, and the position happened to
// line up. Note recovery from a mnemonic matches on exactly this field, so a
// well-meaning "fix" of the name in one place would silently break it.
const DEPOSIT_EVENT = parseAbiItem('event Deposited(address indexed _depositor, uint256 _commitment, uint256 _label, uint256 _value, uint256 _precommitmentHash)');
// Mode-3 shape. This previously read
// `Withdrawn(address indexed _processooor, uint256, uint256, uint256)` — the
// pre-Mode-3 event. The parameter TYPES differ, so `topic0` differed, so
// `getWithdrawals` silently matched NOTHING and returned an empty array on every
// call. `AccountService` reconstructs spent state from these events, so it was
// treating spent notes as unspent. Pinned to the contract by `eventAbis.spec.ts`.
const WITHDRAWAL_EVENT = parseAbiItem('event Withdrawn(uint256 _newCommitmentHashL1, uint256 _newComitmentHashL2, uint256 _value, uint256 _spentNullifier)');
const RAGEQUIT_EVENT = parseAbiItem('event Ragequit(address indexed _ragequitter, uint256 _commitment, uint256 _label, uint256 _value)');

// Mode-3 (Cutout) note-delivery events.
// L1: carries the ephemeral key + view tag a recipient scans for.
const L2NOTE_EVENT = parseAbiItem('event L2Note(uint256 indexed _newCommitmentHashL2, uint256[2] _ephemeralKey, bytes1 indexed _viewTag)');
// L2: bridged tokens + note landed (pending until activated).
const L2_NOTE_RECEIVED_EVENT = parseAbiItem('event NoteReceived(uint256 indexed _commitment, uint256 _value)');
// L2: note became spendable and was inserted into the state tree (insertion order = leaves).
const L2_NOTE_ACTIVATED_EVENT = parseAbiItem('event NoteActivated(uint256 indexed _commitment, uint256 _value)');

/**
 * Service responsible for fetching and managing privacy pool events across multiple chains.
 * Handles event retrieval, parsing, and validation for deposits, withdrawals, and ragequits.
 *
 * @remarks
 * This service uses viem's PublicClient to efficiently fetch and process blockchain events.
 * It supports multiple chains and provides robust error handling and validation.
 * All uint256 values from events are handled as bigints, with Hash type assertions for commitment-related fields.
 */
export class DataService {
  private readonly clients: Map<number, PublicClient> = new Map();
  private readonly logger: Logger;
  private readonly logFetchConfigs: Map<number, LogFetchConfig>;

  /**
   * Initialize the data service with chain configurations
   *
   * @param chainConfigs - Array of chain configurations containing chainId, RPC URL, and API key
   * @param logFetchConfig - Per-chain configuration for rate-limited log fetching as a Map<chainId, config>.
   *                         Each chain can have its own specific settings (e.g., different block chunk sizes).
   * @throws {DataError} If client initialization fails for any chain
   */
  constructor(
    private readonly chainConfigs: ChainConfig[],
    logFetchConfig: ChainLogFetchConfig = new Map()
  ) {
    this.logger = new Logger({ prefix: "Data", level: LogLevel.DEBUG });

    // Initialize per-chain configs with defaults merged with chain-specific overrides
    this.logFetchConfigs = new Map();
    for (const config of chainConfigs) {
      const chainSpecificConfig = logFetchConfig.get(config.chainId);
      this.logFetchConfigs.set(
        config.chainId,
        { ...DEFAULT_LOG_FETCH_CONFIG, ...chainSpecificConfig }
      );
    }

    try {
      for (const config of chainConfigs) {
        if (!config.rpcUrl) {
          throw new Error(`Missing RPC URL for chain ${config.chainId}`);
        }

        const client = createPublicClient({
          transport: http(config.rpcUrl),
        });
        this.clients.set(config.chainId, client);
      }
    } catch (error) {
      throw new DataError(
        "Failed to initialize PublicClient",
        ErrorCode.NETWORK_ERROR,
        { error: error instanceof Error ? error.message : "Unknown error" },
      );
    }
  }

  /**
   * Get deposit events for a specific chain
   *
   * @param pool - Pool info containing chainId, address, and deployment block
   * @returns Array of deposit events with properly typed fields (bigint for numbers, Hash for commitments)
   * @throws {DataError} If client is not configured, network error occurs, or event data is invalid
   */
  async getDeposits(pool: PoolInfo): Promise<DepositEvent[]> {
    try {
      const client = this.getClientForChain(pool.chainId);
      const chainConfig = this.getConfigForChain(pool.chainId);
      const logConfig = this.getLogFetchConfigForChain(pool.chainId);

      const fromBlock = pool.deploymentBlock ?? chainConfig.startBlock;
      const toBlock = await this.getCurrentBlock(pool.chainId);
      const ranges = this.generateBlockRanges(
        fromBlock,
        toBlock,
        logConfig.blockChunkSize
      );

      this.logger.info(
        `Fetching deposits in ${ranges.length} chunks for pool ${pool.address}, chunk size is: ${logConfig.blockChunkSize}`
      );

      // Use async.mapLimit for controlled concurrency
      const allLogs = await mapLimit<BlockRange, unknown[]>(
        ranges,
        logConfig.concurrency,
        async (range: BlockRange) => {
          if (logConfig.chunkDelayMs > 0) {
            await this.sleep(logConfig.chunkDelayMs);
          }
          return this.fetchLogsWithRetry(
            client,
            pool.address,
            DEPOSIT_EVENT,
            range,
            logConfig
          );
        }
      );

      // Flatten and parse results
      const flatLogs = allLogs.flat();

      return flatLogs.map((log: unknown) => {
        try {
          const typedLog = log as {
            args?: {
              _depositor?: string;
              _commitment?: bigint;
              _label?: bigint;
              _value?: bigint;
              _precommitmentHash?: bigint;
            };
            blockNumber?: bigint;
            transactionHash?: Hex;
          };

          if (!typedLog.args) {
            throw DataError.invalidLog("deposit", "missing args");
          }

          const {
            _depositor: depositor,
            _commitment: commitment,
            _label: label,
            _value: value,
            _precommitmentHash: precommitment,
          } = typedLog.args;

          if (
            !depositor ||
            !commitment ||
            !label ||
            !precommitment ||
            !typedLog.blockNumber ||
            !typedLog.transactionHash
          ) {
            throw DataError.invalidLog("deposit", "missing required fields");
          }

          return {
            depositor: depositor.toLowerCase(),
            commitment: commitment as Hash,
            label: label as Hash,
            value: value || BigInt(0),
            precommitment: precommitment as Hash,
            blockNumber: BigInt(typedLog.blockNumber),
            transactionHash: typedLog.transactionHash,
          };
        } catch (error) {
          if (error instanceof DataError) throw error;
          throw DataError.invalidLog(
            "deposit",
            error instanceof Error ? error.message : "Unknown error"
          );
        }
      });
    } catch (error) {
      if (error instanceof DataError) throw error;
      throw DataError.networkError(
        pool.chainId,
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  /**
   * Get withdrawal events for a specific chain
   *
   * @param pool - Pool info containing chainId, address, and deployment block
   * @param fromBlock - Optional starting block (defaults to pool deployment block)
   * @returns Array of withdrawal events with properly typed fields (bigint for numbers, Hash for commitments)
   * @throws {DataError} If client is not configured, network error occurs, or event data is invalid
   */
  async getWithdrawals(
    pool: PoolInfo,
    fromBlock: bigint = pool.deploymentBlock
  ): Promise<WithdrawalEvent[]> {
    try {
      const client = this.getClientForChain(pool.chainId);
      const chainConfig = this.getConfigForChain(pool.chainId);
      const logConfig = this.getLogFetchConfigForChain(pool.chainId);

      const startBlock = fromBlock ?? chainConfig.startBlock;
      const toBlock = await this.getCurrentBlock(pool.chainId);
      const ranges = this.generateBlockRanges(
        startBlock,
        toBlock,
        logConfig.blockChunkSize
      );

      this.logger.debug(
        `Fetching withdrawals in ${ranges.length} chunks for pool ${pool.address}`
      );

      // Use async.mapLimit for controlled concurrency
      const allLogs = await mapLimit<BlockRange, unknown[]>(
        ranges,
        logConfig.concurrency,
        async (range: BlockRange) => {
          if (logConfig.chunkDelayMs > 0) {
            await this.sleep(logConfig.chunkDelayMs);
          }
          return this.fetchLogsWithRetry(
            client,
            pool.address,
            WITHDRAWAL_EVENT,
            range,
            logConfig
          );
        }
      );

      // Flatten and parse results
      const flatLogs = allLogs.flat();

      return flatLogs.map((log: unknown) => {
        try {
          const typedLog = log as {
            args?: {
              _newCommitmentHashL1?: bigint;
              // The contract's own spelling — `_newComitmentHashL2`, one `m`.
              // Matching it is not optional; viem keys decoded args by ABI name.
              _newComitmentHashL2?: bigint;
              _value?: bigint;
              _spentNullifier?: bigint;
            };
            blockNumber?: bigint;
            transactionHash?: Hex;
          };

          if (!typedLog.args) {
            throw DataError.invalidLog("withdrawal", "missing args");
          }

          const {
            _newCommitmentHashL1: newCommitment,
            _newComitmentHashL2: newCommitmentL2,
            _value: value,
            _spentNullifier: spentNullifier,
          } = typedLog.args;

          if (
            value === undefined ||
            value === null ||
            !spentNullifier ||
            !newCommitment ||
            newCommitmentL2 === undefined ||
            !typedLog.blockNumber ||
            !typedLog.transactionHash
          ) {
            throw DataError.invalidLog("withdrawal", "missing required fields");
          }

          return {
            withdrawn: value,
            spentNullifier: spentNullifier as Hash,
            // The L1 change note — the leaf the pool inserts, and the one that
            // continues the account. `C_dest` is bridged, not inserted on L1.
            newCommitment: newCommitment as Hash,
            newCommitmentL2: newCommitmentL2 as Hash,
            blockNumber: BigInt(typedLog.blockNumber),
            transactionHash: typedLog.transactionHash,
          };
        } catch (error) {
          if (error instanceof DataError) throw error;
          throw DataError.invalidLog(
            "withdrawal",
            error instanceof Error ? error.message : "Unknown error"
          );
        }
      });
    } catch (error) {
      if (error instanceof DataError) throw error;
      throw DataError.networkError(
        pool.chainId,
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  /**
   * Get ragequit events for a specific chain
   *
   * @param pool - Pool info containing chainId, address, and deployment block
   * @param fromBlock - Optional starting block (defaults to pool deployment block)
   * @returns Array of ragequit events with properly typed fields (bigint for numbers, Hash for commitments)
   * @throws {DataError} If client is not configured, network error occurs, or event data is invalid
   */
  async getRagequits(
    pool: PoolInfo,
    fromBlock: bigint = pool.deploymentBlock
  ): Promise<RagequitEvent[]> {
    try {
      const client = this.getClientForChain(pool.chainId);
      const chainConfig = this.getConfigForChain(pool.chainId);
      const logConfig = this.getLogFetchConfigForChain(pool.chainId);

      const startBlock = fromBlock ?? chainConfig.startBlock;
      const toBlock = await this.getCurrentBlock(pool.chainId);
      const ranges = this.generateBlockRanges(
        startBlock,
        toBlock,
        logConfig.blockChunkSize
      );

      this.logger.debug(
        `Fetching ragequits in ${ranges.length} chunks for pool ${pool.address}`
      );

      // Use async.mapLimit for controlled concurrency
      const allLogs = await mapLimit<BlockRange, unknown[]>(
        ranges,
        logConfig.concurrency,
        async (range: BlockRange) => {
          if (logConfig.chunkDelayMs > 0) {
            await this.sleep(logConfig.chunkDelayMs);
          }
          return this.fetchLogsWithRetry(
            client,
            pool.address,
            RAGEQUIT_EVENT,
            range,
            logConfig
          );
        }
      );

      // Flatten and parse results
      const flatLogs = allLogs.flat();

      return flatLogs.map((log: unknown) => {
        try {
          const typedLog = log as {
            args?: {
              _ragequitter?: string;
              _commitment?: bigint;
              _label?: bigint;
              _value?: bigint;
            };
            blockNumber?: bigint;
            transactionHash?: Hex;
          };

          if (!typedLog.args) {
            throw DataError.invalidLog("ragequit", "missing args");
          }

          const {
            _ragequitter: ragequitter,
            _commitment: commitment,
            _label: label,
            _value: value,
          } = typedLog.args;

          if (
            !ragequitter ||
            !commitment ||
            !label ||
            !typedLog.blockNumber ||
            !typedLog.transactionHash
          ) {
            throw DataError.invalidLog("ragequit", "missing required fields");
          }

          return {
            ragequitter: ragequitter.toLowerCase(),
            commitment: commitment as Hash,
            label: label as Hash,
            value: value || BigInt(0),
            blockNumber: BigInt(typedLog.blockNumber),
            transactionHash: typedLog.transactionHash,
          };
        } catch (error) {
          if (error instanceof DataError) throw error;
          throw DataError.invalidLog(
            "ragequit",
            error instanceof Error ? error.message : "Unknown error"
          );
        }
      });
    } catch (error) {
      if (error instanceof DataError) throw error;
      throw DataError.networkError(
        pool.chainId,
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  /**
   * Get L1 `L2Note` events — the note-delivery half of Mode-3 relays. Each
   * carries `C_dest`, the ephemeral key `E`, and the view tag a recipient
   * scans for (value is NOT here; see {@link getL2NotesReceived}).
   *
   * @param pool - The L1 pool.
   * @param fromBlock - Optional starting block.
   */
  async getL2Notes(
    pool: PoolInfo,
    fromBlock: bigint = pool.deploymentBlock,
  ): Promise<L2NoteEvent[]> {
    const logs = await this.fetchAllLogs(pool, L2NOTE_EVENT, fromBlock, "l2note");
    return logs.map((log) => {
      const typedLog = log as {
        args?: {
          _newCommitmentHashL2?: bigint;
          _ephemeralKey?: readonly [bigint, bigint];
          _viewTag?: Hex;
        };
        blockNumber?: bigint;
        transactionHash?: Hex;
      };
      const args = typedLog.args;
      if (
        !args?._newCommitmentHashL2 ||
        !args._ephemeralKey ||
        args._viewTag === undefined ||
        !typedLog.blockNumber ||
        !typedLog.transactionHash
      ) {
        throw DataError.invalidLog("l2note", "missing required fields");
      }
      return {
        commitment: args._newCommitmentHashL2 as Hash,
        ephemeralKey: [args._ephemeralKey[0], args._ephemeralKey[1]] as const,
        viewTag: args._viewTag,
        blockNumber: BigInt(typedLog.blockNumber),
        transactionHash: typedLog.transactionHash,
      };
    });
  }

  /**
   * Get L2 `NoteReceived` events — bridged tokens + note have landed (pending
   * until activated). Supplies the cleartext `value` the scanner needs.
   */
  async getL2NotesReceived(
    pool: PoolInfo,
    fromBlock: bigint = pool.deploymentBlock,
  ): Promise<L2NoteReceivedEvent[]> {
    const logs = await this.fetchAllLogs(
      pool,
      L2_NOTE_RECEIVED_EVENT,
      fromBlock,
      "noteReceived",
    );
    return logs.map((log) =>
      this.parseCommitmentValueLog(log, "noteReceived"),
    );
  }

  /**
   * Get L2 `NoteActivated` events — the note became spendable and was inserted
   * into the L2 state tree. Insertion order defines the Merkle leaves; see
   * {@link reconstructL2StateTree}.
   */
  async getL2NotesActivated(
    pool: PoolInfo,
    fromBlock: bigint = pool.deploymentBlock,
  ): Promise<L2NoteActivatedEvent[]> {
    const logs = await this.fetchAllLogs(
      pool,
      L2_NOTE_ACTIVATED_EVENT,
      fromBlock,
      "noteActivated",
    );
    return logs.map((log) =>
      this.parseCommitmentValueLog(log, "noteActivated"),
    );
  }

  /**
   * Join L1 `L2Note` deliveries with L2 `NoteReceived` values into the
   * {@link ScannableNote} candidates a recipient feeds to `NoteService.scanL2Notes`.
   * A delivery with no matching received value yet (bridge still in flight) is
   * omitted — it can't be spent until the tokens land anyway.
   *
   * @param l2Notes - From {@link getL2Notes} (L1).
   * @param received - From {@link getL2NotesReceived} (L2).
   */
  buildScannableNotes(
    l2Notes: readonly L2NoteEvent[],
    received: readonly L2NoteReceivedEvent[],
  ): ScannableNote[] {
    const valueByCommitment = new Map<bigint, bigint>();
    for (const r of received) {
      valueByCommitment.set(r.commitment as bigint, r.value);
    }
    const candidates: ScannableNote[] = [];
    for (const note of l2Notes) {
      const value = valueByCommitment.get(note.commitment as bigint);
      if (value === undefined) continue;
      candidates.push({
        commitment: note.commitment,
        ephemeralKey: note.ephemeralKey,
        viewTag: note.viewTag,
        value,
      });
    }
    return candidates;
  }

  /**
   * Reconstruct the L2 state tree from insertion-ordered `NoteActivated`
   * events, matching the on-chain LeanIMT (Poseidon-2 hasher). Returns the tree
   * so callers can `generateProof(tree.indexOf(cDest))` for a `withdrawL2` proof.
   *
   * Events MUST be passed in chain order (block then log index). Verify
   * `tree.root` against the pool's on-chain `currentRoot()` before proving.
   */
  reconstructL2StateTree(
    activated: readonly L2NoteActivatedEvent[],
  ): LeanIMT<bigint> {
    const tree = new LeanIMT<bigint>((a, b) => poseidon([a, b]));
    for (const ev of activated) {
      tree.insert(ev.commitment as bigint);
    }
    return tree;
  }

  /** Parse a `(uint256 indexed _commitment, uint256 _value)` L2 event log. */
  private parseCommitmentValueLog(
    log: unknown,
    kind: string,
  ): L2NoteReceivedEvent {
    const typedLog = log as {
      args?: { _commitment?: bigint; _value?: bigint };
      blockNumber?: bigint;
      transactionHash?: Hex;
    };
    const args = typedLog.args;
    if (
      !args?._commitment ||
      args._value === undefined ||
      !typedLog.blockNumber ||
      !typedLog.transactionHash
    ) {
      throw DataError.invalidLog(kind, "missing required fields");
    }
    return {
      commitment: args._commitment as Hash,
      value: args._value,
      blockNumber: BigInt(typedLog.blockNumber),
      transactionHash: typedLog.transactionHash,
    };
  }

  /**
   * Chunked, rate-limited, retrying fetch of all logs for one event over the
   * pool's history. Shared by the Mode-3 event getters.
   */
  private async fetchAllLogs(
    pool: PoolInfo,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    event: any,
    fromBlock: bigint | undefined,
    label: string,
  ): Promise<unknown[]> {
    try {
      const client = this.getClientForChain(pool.chainId);
      const chainConfig = this.getConfigForChain(pool.chainId);
      const logConfig = this.getLogFetchConfigForChain(pool.chainId);

      const startBlock = fromBlock ?? chainConfig.startBlock;
      const toBlock = await this.getCurrentBlock(pool.chainId);
      const ranges = this.generateBlockRanges(
        startBlock,
        toBlock,
        logConfig.blockChunkSize,
      );

      this.logger.debug(
        `Fetching ${label} in ${ranges.length} chunks for pool ${pool.address}`,
      );

      const allLogs = await mapLimit<BlockRange, unknown[]>(
        ranges,
        logConfig.concurrency,
        async (range: BlockRange) => {
          if (logConfig.chunkDelayMs > 0) {
            await this.sleep(logConfig.chunkDelayMs);
          }
          return this.fetchLogsWithRetry(
            client,
            pool.address,
            event,
            range,
            logConfig,
          );
        },
      );

      return allLogs.flat();
    } catch (error) {
      if (error instanceof DataError) throw error;
      throw DataError.networkError(
        pool.chainId,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  /**
   * Gets the current block number for a chain
   */
  private async getCurrentBlock(chainId: number): Promise<bigint> {
    const client = this.getClientForChain(chainId);
    return client.getBlockNumber();
  }

  /**
   * Generates block ranges for chunked fetching
   */
  private generateBlockRanges(
    fromBlock: bigint,
    toBlock: bigint,
    chunkSize: number
  ): BlockRange[] {
    const ranges: BlockRange[] = [];
    let current = fromBlock;

    while (current <= toBlock) {
      const end = current + BigInt(chunkSize) - 1n;
      ranges.push({
        fromBlock: current,
        toBlock: end > toBlock ? toBlock : end,
      });
      current = end + 1n;
    }

    return ranges;
  }

  /**
   * Fetches logs for a single block range with retry logic
   */
  private async fetchLogsWithRetry<T>(
    client: PublicClient,
    address: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    event: any,
    range: BlockRange,
    logConfig: LogFetchConfig
  ): Promise<T[]> {
    const maxRetries = logConfig.retryOnFailure
      ? logConfig.maxRetries
      : 0;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const logs = await client.getLogs({
          address: address as `0x${string}`,
          event,
          fromBlock: range.fromBlock,
          toBlock: range.toBlock,
        });
        return logs as T[];
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < maxRetries) {
          const delay =
            logConfig.retryBaseDelayMs * Math.pow(2, attempt);
          this.logger.warn(
            `Log fetch failed, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`,
            { error: lastError.message, range }
          );
          await this.sleep(delay);
        }
      }
    }

    throw lastError;
  }

  /**
   * Helper to add delay between requests
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private getClientForChain(chainId: number): PublicClient {
    const client = this.clients.get(chainId);
    if (!client) {
      throw DataError.chainNotConfigured(chainId);
    }
    return client;
  }

  private getConfigForChain(chainId: number): ChainConfig {
    const config = this.chainConfigs.find((c) => c.chainId === chainId);
    if (!config) {
      throw DataError.chainNotConfigured(chainId);
    }
    return config;
  }

  private getLogFetchConfigForChain(chainId: number): LogFetchConfig {
    const config = this.logFetchConfigs.get(chainId);
    if (!config) {
      // Fallback to default if not found (shouldn't happen if constructor is correct)
      return DEFAULT_LOG_FETCH_CONFIG;
    }
    return config;
  }
}
