import { Ajv, JSONSchemaType } from "ajv";
import { QuotetBody } from "../../interfaces/relayer/quote.js";

// AJV schema for validation
const ajv = new Ajv();

const quoteSchema: JSONSchemaType<QuotetBody> = {
  type: "object",
  properties: {
    chainId: { type: ["string", "number"] },
    destinationChainId: { type: ["string", "number"], nullable: true },
    amount: { type: ["string"], pattern: "^[0-9]+$" },
    asset: { type: ["string"], pattern: "^0x[0-9a-fA-F]{40}$" },
    recipient: { type: ["string"], nullable: true, pattern: "^0x[0-9a-fA-F]{40}$" },
    extraGas: { type: "boolean" }
  },
  required: ["chainId", "amount", "asset"],
} as const;

export const validateQuoteBody = ajv.compile(quoteSchema);
