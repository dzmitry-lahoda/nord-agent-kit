import { z } from "zod";
export const id = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .max(20)
  .refine(
    (value) =>
      /^\d{1,20}$/.test(value) && BigInt(value) <= 18446744073709551615n,
    "Identifier exceeds u64",
  );
export const positiveDecimal = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
  .max(100)
  .refine((x) => /[1-9]/.test(x), "Must be positive");
export const profileName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
export const networkName = z.enum(["devnet", "mainnet"]);
export const profileSchema = z
  .object({
    version: z.literal(1),
    name: profileName,
    network: networkName,
    owner: z.string(),
    accountId: id,
    sessionPublicKey: z.string(),
    sessionId: id.optional(),
    expiry: z.number().int().positive(),
    deadline: z.number().int().positive(),
    credentialId: z.string().uuid(),
    storage: z.enum(["keyring", "file"]),
    authorizationState: z.enum(["submitting", "rejected"]).optional(),
    state: z.enum(["pending", "active", "revoked"]),
    predecessor: z
      .object({
        credentialId: z.string().uuid(),
        storage: z.enum(["keyring", "file"]),
        sessionId: id,
        sessionPublicKey: z.string(),
        expiry: z.number(),
        deadline: z.number(),
      })
      .optional(),
  })
  .strict();
export type Profile = z.infer<typeof profileSchema>;
export const orderSchema = z
  .object({
    marketId: id,
    side: z.enum(["buy", "sell"]),
    type: z.enum(["market", "limit"]),
    baseSize: positiveDecimal.optional(),
    quoteNotional: positiveDecimal.optional(),
    limitPrice: positiveDecimal.optional(),
    slippageBps: z.number().int().min(0).max(9999).optional(),
    reduceOnly: z.boolean().default(false),
  })
  .strict()
  .superRefine((v, c) => {
    if ((v.baseSize !== undefined) === (v.quoteNotional !== undefined))
      c.addIssue({
        code: "custom",
        message: "Specify exactly one of baseSize or quoteNotional",
      });
    if (v.type === "limit" && (!v.limitPrice || v.slippageBps !== undefined))
      c.addIssue({
        code: "custom",
        message:
          "Limit orders require limitPrice and do not accept slippageBps",
      });
    if (
      v.type === "market" &&
      (v.slippageBps === undefined || v.limitPrice !== undefined)
    )
      c.addIssue({
        code: "custom",
        message:
          "Market orders require slippageBps and do not accept limitPrice",
      });
  });
export type OrderInput = z.infer<typeof orderSchema>;
export const requestIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/);
export const pageSchema = z.object({
  limit: z.number().int().min(1).max(50).default(20),
  cursor: id.optional(),
});
export type Json =
  | null
  | boolean
  | string
  | number
  | Json[]
  | { [key: string]: Json };
