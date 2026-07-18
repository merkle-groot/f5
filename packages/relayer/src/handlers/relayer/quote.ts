import { NextFunction, Request, Response } from "express";
import { getAddress, toHex } from "viem";
import { getAssetConfig, getFeeReceiverAddress, getSignerPrivateKey } from "../../config/index.js";
import { QuoterError, ValidationError } from "../../exceptions/base.exception.js";
import { getSdkProvider, web3Provider } from "../../providers/index.js";
import { quoteService } from "../../services/index.js";
import { QuoteMarshall } from "../../types.js";
import { encodeWithdrawalData, isFeeReceiverSameAsSigner, isNative } from "../../utils.js";
import { privateKeyToAccount } from "viem/accounts";
import { QuoteFee } from "../../services/quote.service.js";

// const TIME_20_SECS = 20 * 1000;
const TIME_60_SECS = 60 * 1000;

const EXPIRATION_TIME = TIME_60_SECS;

export async function relayQuoteHandler(
  req: Request,
  res: Response,
  next: NextFunction,
) {

  const chainId = Number(req.body.chainId!);
  const amountIn = BigInt(req.body.amount!.toString());
  const asset = getAddress(req.body.asset!.toString());
  let extraGas = Boolean(req.body.extraGas);

  const config = getAssetConfig(chainId, asset);
  if (config === undefined)
    return next(QuoterError.assetNotSupported(`Asset ${asset} for chain ${chainId} is not supported`));

  if (isNative(asset)) {
    extraGas = false;
  }

  // When a destination chain is supplied, price the L1->L2 message/gas fee the relayer
  // fronts for it into the quote (non-zero for Arbitrum/Starknet, 0 for OP-Stack). Read
  // from the same on-chain bridge config the pool enforces, so quote and relay never drift.
  let bridgeFeeWei = 0n;
  if (req.body.destinationChainId !== undefined && req.body.destinationChainId !== null) {
    try {
      bridgeFeeWei = await getSdkProvider().bridgeMsgValue(
        chainId,
        asset,
        BigInt(req.body.destinationChainId.toString()),
      );
    } catch (e) {
      // Don't fail the quote if the bridge fee can't be read; the relay still attaches the
      // correct `msg.value` at broadcast time. Log so under-pricing is visible.
      console.warn(`[QUOTE] Could not read bridge fee for destination ${req.body.destinationChainId}: ${e}`);
    }
  }

  let quote: QuoteFee;
  try {
    quote = await quoteService.quoteFeeBPSNative({
      chainId, amountIn, assetAddress: asset, baseFeeBPS: config.fee_bps, extraGas: extraGas, bridgeFeeWei
    });
  } catch (e) {
    return next(e);
  }

  const { feeBPS, gasPrice, extraGasFundAmount, relayTxCost, extraGasTxCost } = quote;
  const recipient = req.body.recipient ? getAddress(req.body.recipient.toString()) : undefined;
  const detail = {
    relayTxCost: { gas: relayTxCost, eth: relayTxCost * gasPrice },
    extraGasFundAmount: extraGasFundAmount ? { gas: extraGasFundAmount, eth: extraGasFundAmount * gasPrice } : undefined,
    extraGasTxCost: extraGasTxCost ? { gas: extraGasTxCost, eth: extraGasTxCost * gasPrice } : undefined,
  };

  const quoteResponse = new QuoteMarshall({
    baseFeeBPS: config.fee_bps,
    feeBPS,
    gasPrice,
    detail,
  });

  if (recipient) {
    let feeReceiverAddress: `0x${string}`;
    const finalFeeReceiverAddress = getAddress(getFeeReceiverAddress(chainId));
    if (extraGas) {
      const signer = privateKeyToAccount(getSignerPrivateKey(chainId) as `0x${string}`);
      if (isFeeReceiverSameAsSigner(chainId)) {
        feeReceiverAddress = finalFeeReceiverAddress;
      } else {
        feeReceiverAddress = signer.address;
      }
    } else {
      feeReceiverAddress = finalFeeReceiverAddress;
    }
    // Mode-3: the signed commitment must be byte-identical to the `RelayData`
    // the client will submit (the proof binds context over those exact bytes),
    // so the client provides the stealth material (ephemeralKey + viewTag) it
    // already derived when building the note. See relayer Mode-3 migration.
    const { ephemeralKey, viewTag } = parseStealthQuoteFields(req.body);
    const withdrawalData = encodeWithdrawalData({
      feeRecipient: getAddress(feeReceiverAddress),
      recipient,
      ephemeralKey,
      viewTag,
      relayFeeBPS: feeBPS
    });
    const expiration = Number(new Date()) + EXPIRATION_TIME;
    const relayerCommitment = { withdrawalData, expiration, asset, amount: amountIn, extraGas };
    const signedRelayerCommitment = await web3Provider.signRelayerCommitment(chainId, relayerCommitment);
    quoteResponse.addFeeCommitment({ expiration, asset, withdrawalData, signedRelayerCommitment, extraGas, amount: amountIn });
  }

  res
    .status(200)
    .json(res.locals.marshalResponse(quoteResponse));

}

/**
 * Parse the Mode-3 stealth fields from a quote request body. Only required when
 * the client wants a signed fee commitment (i.e. supplied a `recipient`), since
 * the commitment must reproduce the full on-chain `RelayData`.
 *
 * @throws {ValidationError} If the fields are missing or malformed.
 */
function parseStealthQuoteFields(body: Request["body"]): {
  ephemeralKey: readonly [bigint, bigint];
  viewTag: `0x${string}`;
} {
  const rawKey = body.ephemeralKey;
  if (!Array.isArray(rawKey) || rawKey.length !== 2) {
    throw ValidationError.invalidInput({
      message: "ephemeralKey must be a [x, y] pair to quote a fee commitment.",
    });
  }
  if (body.viewTag === undefined || body.viewTag === null) {
    throw ValidationError.invalidInput({
      message: "viewTag is required to quote a fee commitment.",
    });
  }
  try {
    const ephemeralKey: [bigint, bigint] = [
      BigInt(rawKey[0]),
      BigInt(rawKey[1]),
    ];
    // Normalise viewTag to a single-byte hex string (accepts number or hex).
    const viewTag = toHex(BigInt(body.viewTag) & 0xffn, { size: 1 });
    return { ephemeralKey, viewTag };
  } catch {
    throw ValidationError.invalidInput({
      message: "ephemeralKey/viewTag are malformed.",
    });
  }
}
