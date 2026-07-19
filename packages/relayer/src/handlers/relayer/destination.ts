import { NextFunction, Request, Response } from "express";
import { WithdrawalProof } from "@0xbow/privacy-pools-core-sdk";
import { ValidationError } from "../../exceptions/base.exception.js";
import { getDestinationService } from "../../services/index.js";
import { DestinationWithdrawal } from "../../providers/destination/types.js";
import {
  zActivateRequest,
  zDestinationWithdrawRequest,
} from "../../schemes/relayer/destination.scheme.js";

/** GET /relayer/destinations — every destination the relayer can write to. */
export async function listDestinationsHandler(
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    res.status(200).json({ destinations: getDestinationService().list() });
  } catch (error) {
    next(error);
  }
}

/** GET /relayer/destinations/:key — one destination's config and signer address. */
export async function destinationDetailsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    res.status(200).json(getDestinationService().details(req.params.key!));
  } catch (error) {
    next(error);
  }
}

/** POST /relayer/destinations/:key/activate — promote a bridged note to spendable. */
export async function destinationActivateHandler(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const parsed = zActivateRequest.safeParse(req.body);
    if (!parsed.success) {
      throw ValidationError.invalidInput({
        message: parsed.error.errors.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"),
      });
    }

    const result = await getDestinationService().activate(req.params.key!, parsed.data.commitment);
    // A refused or reverted write is a 502, not a 200-with-error: callers poll this
    // and would otherwise read a failure as a completed activation.
    res.status(result.success ? 200 : 502).json(result);
  } catch (error) {
    next(error);
  }
}

/** POST /relayer/destinations/:key/withdraw — spend an activated note. */
export async function destinationWithdrawHandler(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const parsed = zDestinationWithdrawRequest.safeParse(req.body);
    if (!parsed.success) {
      throw ValidationError.invalidInput({
        message: parsed.error.errors.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"),
      });
    }

    const proof = {
      proof: { ...parsed.data.proof, protocol: "groth16", curve: "bn128" },
      publicSignals: parsed.data.publicSignals,
    } as WithdrawalProof;

    const result = await getDestinationService().withdraw(
      req.params.key!,
      parsed.data.withdrawal as DestinationWithdrawal,
      proof,
    );
    res.status(result.success ? 200 : 502).json(result);
  } catch (error) {
    next(error);
  }
}
