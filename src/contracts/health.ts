import { z } from "zod";

export const HealthResponseSchema = z.object({
  status: z.literal("ok"),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "Expected a SemVer version"),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
