import { nextStepChip } from "@/lib/next-step-chip";

export interface ClosedFollowUp {
  follow_up_date: string | null;
  follow_up_notes: string | null;
  subject: string | null;
}

/**
 * The timeline lines that say a follow-up was closed, so it doesn't just vanish from the lead.
 * `replacedBy` names what closed it ("Spoke") when a logged action did; Mark done leaves it out.
 */
export function followUpClosedRows(opts: {
  leadId: string;
  closed: ClosedFollowUp[];
  createdBy: string | null | undefined;
  replacedBy?: string;
  now?: Date;
}) {
  return opts.closed.map((f) => {
    const what = f.follow_up_notes?.trim() || f.subject?.trim() || "Follow-up";
    let due = "";
    if (f.follow_up_date) {
      const chip = nextStepChip(f.follow_up_date, opts.now);
      due =
        chip.state === "overdue"
          ? ` (was due ${chip.when.replace(/^was /, "")}, ${chip.big})`
          : ` (was due ${chip.state === "today" ? "today" : chip.when})`;
    }
    return {
      lead_id: opts.leadId,
      type: "note" as const,
      subject: "Follow-up closed",
      description: `"${what}"${due}${opts.replacedBy ? ` · replaced by ${opts.replacedBy}` : ""}`,
      created_by: opts.createdBy ?? null,
    };
  });
}
