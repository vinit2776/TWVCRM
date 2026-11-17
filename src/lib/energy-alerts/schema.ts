import { z } from "zod";
import { parseEmailList } from "@/lib/email-recipients";

export const ENERGY_ALERT_VIEW_ROLES = ["admin", "manager", "it_manager", "fms"] as const;
export const ENERGY_ALERT_MANAGE_ROLES = ["admin", "manager"] as const;

export const ACK_REASONS = ["Known event", "Maintenance", "Holiday / low footfall", "Fixed it", "False alarm"] as const;
// Episodes acknowledged as one of these were not a real fault (or were a known abnormal day).
// "False alarm" days are normal days, so they stay in the baseline; the others are left out of it.
export const BASELINE_EXCLUDING_REASONS: readonly string[] = ["Known event", "Maintenance", "Holiday / low footfall", "Fixed it"];

export const MAX_RECIPIENTS = 10;

const recipientsField = z.string().transform((text, ctx) => {
  const { emails, invalid } = parseEmailList(text);
  if (invalid.length > 0) { ctx.addIssue({ code: "custom", message: `Not an email address: ${invalid.join(", ")}` }); return z.NEVER; }
  if (emails.length > MAX_RECIPIENTS) { ctx.addIssue({ code: "custom", message: `At most ${MAX_RECIPIENTS} recipients.` }); return z.NEVER; }
  return emails;
});

const ruleShape = {
  name: z.string().trim().min(1).max(120),
  location_id: z.string().uuid(),
  tolerance_pct: z.number().min(1).max(100),
  min_kw: z.number().min(0).max(1000),
  direction: z.enum(["both", "high", "low"]),
  persist_slots: z.number().int().min(1).max(8),
  recover_slots: z.number().int().min(1).max(16),
  reminder_schedule: z.enum(["std", "4h", "none"]),
  daily_cap: z.number().int().min(1).max(24),
  recipients: recipientsField,
  send_resolved: z.boolean(),
  mode: z.enum(["test", "live"]),
  enabled: z.boolean(),
};

export const ruleCreateSchema = z.object(ruleShape);
export const rulePatchSchema = z.object(ruleShape).partial();
export const ackSchema = z.object({ reason: z.enum(ACK_REASONS) });
export const muteSchema = z.object({ hours: z.number().min(0).max(24 * 14) }); // 0 clears the mute
export const backtestSchema = z.object({
  location_id: z.string().uuid(),
  tolerance_pct: z.number().min(1).max(100),
  min_kw: z.number().min(0).max(1000),
  direction: z.enum(["both", "high", "low"]),
  persist_slots: z.number().int().min(1).max(8),
  recover_slots: z.number().int().min(1).max(16),
  reminder_schedule: z.enum(["std", "4h", "none"]),
  daily_cap: z.number().int().min(1).max(24),
});
export const modeSchema = z.object({ mode: z.enum(["off", "dry_run", "live"]) });
export const runSchema = z.object({ rule_id: z.string().uuid().optional(), dry: z.boolean().optional() });
