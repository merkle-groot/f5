/**
 * Recipient-address validation, shared by the two places a user types one.
 *
 * Both fields used to be checked only at submit — the send recipient inside
 * `resolveRecipient`, the withdrawal recipient inside `prepareL2Proof`, after a
 * status round-trip. So a typo surfaced at the end of the flow instead of at the
 * keystroke that caused it. These are the same rules, callable while typing.
 *
 * Every function returns a human problem string, or "" when there is nothing to
 * say. An empty field is "not yet", never "wrong", so it reports no problem.
 */
import { isAddress } from "viem";

/** Starknet addresses are felt252 values, so they are bounded by the field, not by a byte width. */
const FELT_LIMIT = 1n << 251n;

/** What is wrong with `value` as an Ethereum address, or "". */
export function evmAddressProblem(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (!text.startsWith("0x")) return "An Ethereum address starts with 0x.";
  if (text.length !== 42) return `An Ethereum address is 42 characters — this is ${text.length}.`;
  if (!/^0x[0-9a-fA-F]{40}$/.test(text)) return "An Ethereum address uses only hex digits.";
  // Correct hex of the right length that still fails `isAddress` can only be a
  // checksum mismatch. Saying so beats "invalid address" on an address whose
  // digits are perfectly right and whose capitalisation is not.
  if (!isAddress(text)) return "That address's capitalisation fails its checksum — paste it again or use all lowercase.";
  return "";
}

/** What is wrong with `value` as a Starknet felt252 recipient, or "". */
export function starknetAddressProblem(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (!/^(?:0x[0-9a-fA-F]+|\d+)$/.test(text)) return "Enter a felt252 as hex (0x…) or decimal digits.";
  if (BigInt(text) >= FELT_LIMIT) return "That value is too large to be a felt252.";
  return "";
}

/** Route a recipient to the right rules for the chain it will land on. */
export function recipientProblem(value, chain) {
  return chain === "starknet" ? starknetAddressProblem(value) : evmAddressProblem(value);
}
