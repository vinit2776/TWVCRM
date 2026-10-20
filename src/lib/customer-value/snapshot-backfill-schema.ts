import { z } from "zod";

/**
 * Body of POST /api/admin/customer-value/backfill.
 *
 * Built to be fail-safe. The 1 September 2026 incident (CLAUDE.md) was a
 * mistyped flag silently falling back to a live run. So:
 *  - `.strict()`: an unknown key, including a misspelling such as `dryRun`, is
 *    rejected with a 400 instead of being ignored.
 *  - `dry_run` defaults to **true**: an empty body, or a body that only picks
 *    customers, can never write.
 *  - `dry_run` must be the boolean `false` to write; the string "false" or 0 is
 *    rejected rather than coerced.
 */
export const backfillBodySchema = z
  .object({
    /** One customer; omit to work through all of them in pages. */
    lead_id: z.string().uuid().optional(),
    /** Customers per request when paging. */
    limit: z.number().int().min(1).max(100).default(25),
    /** Resume after this customer id (the `next_after` of the previous response). */
    after: z.string().uuid().optional(),
    /** none = monthly figures only; latest = also today's score; history = also every month end. */
    scores: z.enum(["none", "latest", "history"]).default("none"),
    dry_run: z.boolean().default(true),
  })
  .strict();

export type BackfillBody = z.infer<typeof backfillBodySchema>;
