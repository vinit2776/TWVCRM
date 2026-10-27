import { describe, it, expect } from "vitest";
import {
  groupForConsolidatedReminder, reminderLeadKey, splitAttachable, MAX_REMINDER_ATTACHMENTS,
  type ReminderCandidate,
} from "@/lib/reminder-consolidation";

const c = (id: string, leadKey: string, daysOverdue: number, gatePass: boolean): ReminderCandidate<string> =>
  ({ statement: id, leadKey, daysOverdue, gatePass });

describe("reminderLeadKey", () => {
  it("prefers the lead id, then email, then the statement", () => {
    expect(reminderLeadKey({ id: "L1", email: "a@x.com" }, "S1")).toBe("lead:L1");
    expect(reminderLeadKey({ email: " A@X.com " }, "S1")).toBe("email:a@x.com");
    expect(reminderLeadKey(null, "S1")).toBe("stmt:S1");
  });
});

describe("groupForConsolidatedReminder", () => {
  it("merges one customer's invoices into one group, most overdue first", () => {
    const { send } = groupForConsolidatedReminder([
      c("new", "lead:A", 7, true), c("old", "lead:A", 37, false), c("mid", "lead:A", 22, false),
    ]);
    expect(send).toHaveLength(1);
    expect(send[0].members.map((m) => m.statement)).toEqual(["old", "mid", "new"]);
  });

  it("sends the whole group when only one member is due a reminder", () => {
    const { send, held } = groupForConsolidatedReminder([c("a", "lead:A", 3, true), c("b", "lead:A", 30, false)]);
    expect(send).toHaveLength(1);
    expect(held).toHaveLength(0);
    expect(send[0].members).toHaveLength(2);
  });

  it("holds a group where no member passes its gate", () => {
    const { send, held } = groupForConsolidatedReminder([c("a", "lead:A", 3, false), c("b", "lead:A", 9, false)]);
    expect(send).toHaveLength(0);
    expect(held[0].members).toHaveLength(2);
  });

  it("never merges different customers", () => {
    const { send } = groupForConsolidatedReminder([c("a", "lead:A", 3, true), c("b", "lead:B", 3, true)]);
    expect(send).toHaveLength(2);
  });
});

describe("splitAttachable", () => {
  it("attaches up to the cap and reports the rest", () => {
    const items = Array.from({ length: 8 }, (_, i) => i);
    const r = splitAttachable(items);
    expect(r.attach).toHaveLength(MAX_REMINDER_ATTACHMENTS);
    expect(r.omitted).toBe(3);
  });
  it("omits nothing under the cap", () => {
    expect(splitAttachable([1, 2]).omitted).toBe(0);
  });
});
