import { describe, it, expect, vi } from "vitest";
import { advanceCaseStage, advanceCaseOnAgreementExecuted } from "@/lib/case-status-events";

/** Minimal Supabase stub: records updates, serves canned reads. */
function makeClient(opts: {
  caseRow?: Record<string, unknown> | null;
  statement?: Record<string, unknown> | null;
}) {
  const updates: Record<string, unknown>[] = [];
  const client = {
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        is: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () =>
          table === "cases" ? { data: opts.caseRow ?? null } : { data: opts.statement ?? null },
        update(values: Record<string, unknown>) {
          updates.push(values);
          return { eq: async () => ({ error: null }) };
        },
      };
      return builder;
    },
  };
  return { client: client as never, updates };
}

describe("advanceCaseStage", () => {
  it("advances a case that is behind the target stage", async () => {
    const { client, updates } = makeClient({ caseRow: { status: "intake_received" } });
    await advanceCaseStage(client, "case-1", "docs_received");
    expect(updates).toHaveLength(1);
    expect(updates[0].status).toBe("docs_received");
  });

  it("never moves a case backwards", async () => {
    const { client, updates } = makeClient({ caseRow: { status: "active" } });
    await advanceCaseStage(client, "case-1", "invoiced");
    expect(updates).toHaveLength(0);
  });

  it("is a no-op when already at the target stage", async () => {
    const { client, updates } = makeClient({ caseRow: { status: "paid" } });
    await advanceCaseStage(client, "case-1", "paid");
    expect(updates).toHaveLength(0);
  });

  it("treats retired hand-off states as their equivalent stage", async () => {
    // under_review ranks alongside docs_received, so re-reporting docs_received
    // must not rewrite a case someone manually put under review.
    const { client, updates } = makeClient({ caseRow: { status: "under_review" } });
    await advanceCaseStage(client, "case-1", "docs_received");
    expect(updates).toHaveLength(0);
  });

  it("swallows a missing case rather than throwing", async () => {
    const { client, updates } = makeClient({ caseRow: null });
    await expect(advanceCaseStage(client, "nope", "invoiced")).resolves.toBeUndefined();
    expect(updates).toHaveLength(0);
  });
});

describe("advanceCaseOnAgreementExecuted", () => {
  it("activates a postpaid case on execution alone", async () => {
    const { client, updates } = makeClient({
      caseRow: { status: "docs_received", aggregator_id: "agg-1", aggregator: { billing_method: "postpaid" } },
    });
    await advanceCaseOnAgreementExecuted(client, "case-1");
    expect(updates.at(-1)?.status).toBe("active");
  });

  it("does not activate a direct case whose invoice is unpaid", async () => {
    const { client, updates } = makeClient({
      caseRow: { status: "invoiced", aggregator_id: null, aggregator: null },
      statement: { payment_status: "unpaid" },
    });
    await advanceCaseOnAgreementExecuted(client, "case-1");
    expect(updates).toHaveLength(0);
  });

  it("activates a direct case once its invoice is paid", async () => {
    const { client, updates } = makeClient({
      caseRow: { status: "paid", aggregator_id: null, aggregator: null },
      statement: { payment_status: "paid" },
    });
    await advanceCaseOnAgreementExecuted(client, "case-1");
    expect(updates.at(-1)?.status).toBe("active");
  });

  it("does not activate a prepaid aggregator case with no invoice at all", async () => {
    const { client, updates } = makeClient({
      caseRow: { status: "docs_received", aggregator_id: "agg-1", aggregator: { billing_method: "prepaid" } },
      statement: null,
    });
    await advanceCaseOnAgreementExecuted(client, "case-1");
    expect(updates).toHaveLength(0);
  });
});

describe("error containment", () => {
  it("never throws when the client itself fails", async () => {
    const exploding = {
      from() { throw new Error("connection lost"); },
    } as never;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(advanceCaseStage(exploding, "case-1", "paid")).resolves.toBeUndefined();
    await expect(advanceCaseOnAgreementExecuted(exploding, "case-1")).resolves.toBeUndefined();
    spy.mockRestore();
  });
});
