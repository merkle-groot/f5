/**
 * Pool event and view definitions, with the parsers that turn raw logs into the
 * shapes the rest of the server uses.
 *
 * Every parser validates before it destructures. An RPC that returns a log with a
 * missing field is not a theoretical concern — the alternative is a silent
 * `undefined` propagating into a commitment or a value, where it becomes a wrong
 * answer rather than an error.
 */
import { LeanIMT } from "@zk-kit/lean-imt";
import { poseidon } from "maci-crypto/build/ts/hashing.js";

// --- L1 pool -----------------------------------------------------------------

export const depositedEvent = {
  type: "event",
  name: "Deposited",
  inputs: [
    { name: "_depositor", type: "address", indexed: true },
    { name: "_commitment", type: "uint256", indexed: false },
    { name: "_label", type: "uint256", indexed: false },
    { name: "_value", type: "uint256", indexed: false },
    { name: "_precommitmentHash", type: "uint256", indexed: false },
  ],
};
export const depositedKey = "Deposited(address,uint256,uint256,uint256,uint256)";

export const leafInsertedEvent = {
  type: "event",
  name: "LeafInserted",
  inputs: [
    { name: "_index", type: "uint256", indexed: false },
    { name: "_leaf", type: "uint256", indexed: false },
    { name: "_root", type: "uint256", indexed: false },
  ],
};
export const leafInsertedKey = "LeafInserted(uint256,uint256,uint256)";

export const withdrawnEvent = {
  type: "event",
  name: "Withdrawn",
  inputs: [
    { name: "_newCommitmentHashL1", type: "uint256", indexed: false },
    { name: "_newCommitmentHashL2", type: "uint256", indexed: false },
    { name: "_value", type: "uint256", indexed: false },
    { name: "_spentNullifier", type: "uint256", indexed: false },
  ],
};
export const withdrawnKey = "Withdrawn(uint256,uint256,uint256,uint256)";

export const ragequitEvent = {
  type: "event",
  name: "Ragequit",
  inputs: [
    { name: "_ragequitter", type: "address", indexed: true },
    { name: "_commitment", type: "uint256", indexed: false },
    { name: "_label", type: "uint256", indexed: false },
    { name: "_value", type: "uint256", indexed: false },
  ],
};
export const ragequitKey = "Ragequit(address,uint256,uint256,uint256)";

/** The stealth material for a Mode-3 note, emitted on L1 regardless of destination. */
export const l2NoteEvent = {
  type: "event",
  name: "L2Note",
  inputs: [
    { name: "_newCommitmentHashL2", type: "uint256", indexed: true },
    { name: "_ephemeralKey", type: "uint256[2]", indexed: false },
    { name: "_viewTag", type: "bytes1", indexed: true },
  ],
};
export const l2NoteKey = "L2Note(uint256,uint256[2],bytes1)";

/**
 * The one L1 pool log stream shared by recovery, state proofs, delivery scans,
 * activity, and spent-note reconciliation. One OR-topic request over a block range
 * is much cheaper than maintaining a separate cursor for every event type.
 */
export const l1PoolEvents = [
  depositedEvent,
  leafInsertedEvent,
  withdrawnEvent,
  ragequitEvent,
  l2NoteEvent,
];
export const l1PoolKey = [
  depositedKey,
  leafInsertedKey,
  withdrawnKey,
  ragequitKey,
  l2NoteKey,
].join("|");

// --- L2 pool -----------------------------------------------------------------

export const noteReceivedEvent = {
  type: "event",
  name: "NoteReceived",
  inputs: [
    { name: "_commitment", type: "uint256", indexed: true },
    { name: "_value", type: "uint256", indexed: false },
  ],
};
export const noteReceivedKey = "NoteReceived(uint256,uint256)";

export const noteActivatedEvent = { ...noteReceivedEvent, name: "NoteActivated" };
export const noteActivatedKey = "NoteActivated(uint256,uint256)";

/**
 * The destination pool's spend event.
 *
 * `_spentNullifier` is the `withdrawL2` circuit's `existingNullifierHash`, i.e.
 * `Poseidon(stealthPrivateKey, C_dest)` (`commitmentL2Withdraw.circom`). A recipient
 * holds both halves of that preimage for every note their scan matched, so this is the
 * one public signal that lets a wallet recognise its OWN spent notes — the pool's
 * `nullifierHashes` mapping is unlinkable to a commitment by design.
 */
export const l2WithdrawnEvent = {
  type: "event",
  name: "Withdrawn",
  inputs: [
    { name: "_recipient", type: "address", indexed: true },
    { name: "_spentNullifier", type: "uint256", indexed: false },
    { name: "_value", type: "uint256", indexed: false },
    { name: "_feeAmount", type: "uint256", indexed: false },
  ],
};
export const l2WithdrawnKey = "Withdrawn(address,uint256,uint256,uint256)";

/**
 * One topic-0 OR filter for a destination note's whole lifecycle: arrival, activation,
 * and spend.
 *
 * `Withdrawn` rides in the SAME filter as the other two rather than getting a cursor of
 * its own. Spending never removes the leaf — the pool just sets `nullifierHashes[h]`
 * (`L2PrivacyPool.sol:288`) — so a spent note keeps a valid Merkle proof forever and
 * inclusion cannot be read as spendability. Anything that lists activated notes has to
 * subtract the spent ones or it reports stale notes as spendable, which is exactly the
 * bug this stream was widened to fix.
 */
export const noteLifecycleEvents = [noteReceivedEvent, noteActivatedEvent, l2WithdrawnEvent];
export const noteLifecycleKey = `${noteReceivedKey}|${noteActivatedKey}|${l2WithdrawnKey}`;

/** Native bridge backing. ERC20/Starknet backing is signalled by the asset's Transfer event. */
export const backingReceivedEvent = {
  type: "event",
  name: "BackingReceived",
  inputs: [
    { name: "_value", type: "uint256", indexed: false },
    { name: "_totalReceived", type: "uint256", indexed: false },
  ],
};
export const backingReceivedKey = "BackingReceived(uint256,uint256)";

export const transferEvent = {
  type: "event",
  name: "Transfer",
  inputs: [
    { name: "from", type: "address", indexed: true },
    { name: "to", type: "address", indexed: true },
    { name: "value", type: "uint256", indexed: false },
  ],
};
export const transferKey = "Transfer(address,address,uint256)";

/**
 * The backing views the activation scanner reads (CLAUDE.md §6). The relayer
 * re-reads the same views per commitment before it signs.
 */
export const l2BackingAbi = [
  {
    type: "function",
    name: "activatedSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "tokensReceivedFromBridge",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
];

export const l2StatusAbi = [
  {
    type: "function",
    name: "receivedCommitments",
    stateMutability: "view",
    inputs: [{ name: "commitment", type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "pendingValue",
    stateMutability: "view",
    inputs: [{ name: "commitment", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "currentRoot",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "roots",
    stateMutability: "view",
    inputs: [{ name: "index", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "ROOT_HISTORY_SIZE",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint32" }],
  },
];

export const scopeAbi = [
  { type: "function", name: "SCOPE", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
];

export const currentRootAbi = [
  { type: "function", name: "currentRoot", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
];

export const assetConfigAbi = [
  {
    type: "function",
    name: "assetConfig",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      { name: "pool", type: "address" },
      { name: "minimumDepositAmount", type: "uint256" },
      { name: "vettingFeeBPS", type: "uint256" },
      { name: "maxRelayFeeBPS", type: "uint256" },
    ],
  },
];

// --- parsers -----------------------------------------------------------------

function require_(log, fields, kind) {
  const args = log.args ?? {};
  for (const field of fields) {
    if (args[field] === undefined) throw new Error(`Invalid ${kind} log returned by RPC`);
  }
  if (log.blockNumber === undefined || !log.transactionHash) {
    throw new Error(`Invalid ${kind} log returned by RPC`);
  }
  return args;
}

export function parseDepositLog(log) {
  const args = require_(
    log,
    ["_depositor", "_commitment", "_label", "_value", "_precommitmentHash"],
    "Deposited",
  );
  return {
    depositor: args._depositor.toLowerCase(),
    commitment: args._commitment,
    label: args._label,
    value: args._value,
    precommitment: args._precommitmentHash,
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
  };
}

export function parseWithdrawalLog(log) {
  const args = require_(
    log,
    ["_newCommitmentHashL1", "_newCommitmentHashL2", "_value", "_spentNullifier"],
    "Withdrawn",
  );
  return {
    withdrawn: args._value,
    spentNullifier: args._spentNullifier,
    newCommitment: args._newCommitmentHashL1,
    newCommitmentL2: args._newCommitmentHashL2,
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
  };
}

export function parseL2NoteLog(log) {
  const args = require_(log, ["_newCommitmentHashL2", "_ephemeralKey", "_viewTag"], "L2Note");
  if (!args._ephemeralKey) throw new Error("Invalid L2Note log returned by RPC");
  return {
    commitment: args._newCommitmentHashL2,
    ephemeralKey: [args._ephemeralKey[0], args._ephemeralKey[1]],
    viewTag: args._viewTag,
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
  };
}

export function parseL2WithdrawnLog(log) {
  const args = require_(log, ["_spentNullifier", "_value"], "Withdrawn");
  return {
    spentNullifier: args._spentNullifier,
    value: args._value,
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
  };
}

export function parseCommitmentValueLog(log, kind) {
  const args = require_(log, ["_commitment", "_value"], kind);
  return {
    commitment: args._commitment,
    value: args._value,
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
  };
}

// --- derived views -----------------------------------------------------------

/**
 * Join L1 stealth material with L2 cleartext values to produce scannable notes.
 *
 * A recipient needs both halves and they are emitted on different chains: `C_dest`
 * folds the value in, so confirming a note needs `(ephemeralKey, viewTag)` from L1
 * joined with the `value`, which only exists once the tokens land on the destination.
 * A delivery with no matching arrival is dropped — the bridge has not settled yet.
 */
export function buildScannableNotes(deliveries, received) {
  const values = new Map(received.map((event) => [event.commitment, event.value]));
  return deliveries.flatMap((note) => {
    const value = values.get(note.commitment);
    return value === undefined
      ? []
      : [{
          commitment: note.commitment,
          ephemeralKey: note.ephemeralKey,
          viewTag: note.viewTag,
          value,
        }];
  });
}

/**
 * Rebuild a destination pool's state tree from its activation events.
 *
 * The Cairo pool hashes with `garaga::hashes::poseidon_bn254`, i.e. the same
 * circomlib-compatible Poseidon as the EVM pool and the `withdrawL2` circuit, so one
 * reconstruction serves both families.
 */
export function reconstructL2StateTree(activated) {
  const tree = new LeanIMT((left, right) => poseidon([left, right]));
  for (const event of activated) tree.insert(event.commitment);
  return tree;
}
