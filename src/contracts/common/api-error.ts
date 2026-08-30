import { z } from "zod";

/**
 * The single frozen external error envelope. Every non-2xx management response has exactly this shape.
 * `code` is a stable machine token, `message` is a safe human string that never contains SQLSTATE,
 * PostgreSQL text, stack traces, or service-role detail. `requestId` echoes the server-generated id.
 * `details` is present only for request-validation failures and carries safe field-level messages.
 */

export const ApiErrorDetailSchema = z.object({
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
});

export type ApiErrorDetail = z.infer<typeof ApiErrorDetailSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    requestId: z.string().uuid(),
    details: z.array(ApiErrorDetailSchema).optional(),
  }),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;
