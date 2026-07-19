import { ActivationState } from "./types.js";

/** Why a nominated activation was refused, or null when it is safe to broadcast. */
export type ActivationRefusal = "not-pending" | "unbacked";

/**
 * Decide whether one nominated activation can be broadcast.
 *
 * Mirrors the pool's own guard exactly — `activatedSupply + value <= tokensReceived`
 * (CLAUDE.md §6, `L2PrivacyPool._activate`). The contract re-checks this
 * authoritatively; this exists so the relayer never spends gas on a transaction it
 * can already tell will revert.
 *
 * The app server nominates candidates by scanning, but its view can be stale by the
 * time the request lands, and it is not the component paying for the revert. So this
 * check is re-run here against freshly read chain state, and it is not optional.
 */
export function checkActivation(state: ActivationState): ActivationRefusal | null {
  // Zero means either never received, or already activated. Both are refusals, and
  // the pool cannot distinguish them for us — `pendingValue` is cleared on activation.
  if (state.pendingValue <= 0n) return "not-pending";
  if (state.activatedSupply + state.pendingValue > state.tokensReceived) return "unbacked";
  return null;
}
