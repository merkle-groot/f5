import { z } from "zod";
import { zAddress, zHex, zProof } from "./request.scheme.js";

/** The BN254 scalar field order. A commitment outside it cannot be a valid note. */
const BN254_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const zFieldElement = z
  .string()
  .or(z.number())
  .pipe(z.coerce.bigint().nonnegative())
  .refine((v) => v < BN254_FIELD, "must be inside the BN254 scalar field");

const zFelt = z
  .string()
  .regex(/^(?:0x[0-9a-fA-F]+|\d+)$/, "must be a hex or decimal felt")
  .refine((v) => BigInt(v) < (1n << 251n), "must be below the felt252 field bound");

export const zActivateRequest = z
  .object({
    commitment: zFieldElement,
  })
  .strict()
  .readonly();

/** The EVM L2 pool's `Withdrawal{processooor,data}`. */
const zEvmWithdrawal = z
  .object({
    processooor: zAddress,
    data: zHex,
  })
  .strict();

/**
 * The Starknet pool's flat felt arguments. `relayFeeBPS` defaults to 0 because the
 * destination spend's fee is set by the recipient and is routinely zero.
 */
const zStarknetWithdrawal = z
  .object({
    processooor: zFelt,
    recipient: zFelt,
    feeRecipient: zFelt,
    relayFeeBPS: zFelt.default("0"),
  })
  .strict();

/** The `withdrawL2` circuit exposes 5 signals; see contracts.service.withdrawL2. */
const zL2PublicSignals = z.array(z.string()).length(5);

/**
 * A nested `{proof, publicSignals}` — what `PrivacyPoolSDK.proveWithdrawalL2` returns
 * and what the app posts for EVM destinations.
 */
const zNestedProof = z.object({
  proof: zProof,
  publicSignals: zL2PublicSignals,
});

export const zDestinationWithdrawRequest = z
  .object({
    // A union rather than a discriminator: the caller does not tag the shape, and
    // the two are unambiguous (one has `data`, the other has `recipient`).
    withdrawal: z.union([zEvmWithdrawal, zStarknetWithdrawal]),
    // Both shapes the app already posts are accepted — nested (EVM path) and flat
    // with sibling `publicSignals` (Starknet path). Normalising here rather than in
    // the app server is deliberate: it keeps the proxy a dumb passthrough, which is
    // the entire point of moving transaction handling down here.
    proof: z.union([zNestedProof, zProof]),
    publicSignals: zL2PublicSignals.optional(),
  })
  .strict()
  .readonly()
  .transform((body) => {
    const nested = "proof" in body.proof ? body.proof : null;
    const publicSignals = nested?.publicSignals ?? body.publicSignals;
    return {
      withdrawal: body.withdrawal,
      proof: nested ? nested.proof : body.proof,
      publicSignals,
    };
  })
  .refine(
    (body): body is typeof body & { publicSignals: string[] } => body.publicSignals !== undefined,
    { message: "publicSignals are required when proof is not nested" },
  );

export type ActivateRequestBody = z.infer<typeof zActivateRequest>;
export type DestinationWithdrawRequestBody = z.infer<typeof zDestinationWithdrawRequest>;
