import { z } from "zod";

// Admin-only corrections to procurement steps. Every rollback undoes exactly
// one step, needs a written reason, and is recorded as audit action "rollback".
// Only admin may roll back — users who made the mistake route it to an admin.
export const ROLLBACK_ROLES = ["admin"] as const;

export function canRollback(role: string | null | undefined): boolean {
  return !!role && (ROLLBACK_ROLES as readonly string[]).includes(role);
}

export const rollbackReasonSchema = z
  .string()
  .trim()
  .min(10, "Give a reason of at least 10 characters — it is saved to the audit trail");
