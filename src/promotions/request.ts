import { z } from "zod";

// Simple offset pagination for the management list (the DB caps the page at 200).
export const PromotionListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type PromotionListQuery = z.infer<typeof PromotionListQuerySchema>;

export const PromotionPathSchema = z.object({ promotionId: z.string().uuid() }).strict();
export const PromotionCodePathSchema = z.object({ codeId: z.string().uuid() }).strict();
