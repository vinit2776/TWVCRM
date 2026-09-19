import { describe, it, expect } from "vitest";
import { digestSubject, renderQueryDigest, type QueryDigestEmailItem } from "@/lib/queries/digest-email";

function item(over: Partial<QueryDigestEmailItem> = {}): QueryDigestEmailItem {
  return {
    url: "https://twv-crm.vercel.app/queries?open=q1",
    entityLabel: "Bluescale Analytics · TWV-C-0112",
    kindLabel: "Question",
    badges: [{ kind: "new", label: "New" }],
    awaitingYou: false,
    latestReply: null,
    neededBy: null,
    ...over,
  };
}

describe("digestSubject", () => {
  it("counts threads, singular and plural", () => {
    expect(digestSubject([item()])).toBe("Query digest · 1 thread");
    expect(digestSubject([item(), item()])).toBe("Query digest · 2 threads");
  });

  it("calls out how many are overdue or gone silent", () => {
    const overdue = item({ badges: [{ kind: "overdue", label: "Overdue 2 days" }] });
    const silent = item({ badges: [{ kind: "escalated", label: "No reply for 3 days" }] });
    expect(digestSubject([overdue, silent, item()])).toBe("Query digest · 3 threads · 2 overdue");
  });
});

describe("renderQueryDigest", () => {
  it("escapes user-typed text so a reply can't inject markup into the email", () => {
    const { html } = renderQueryDigest([
      item({ latestReply: '<img src=x onerror="alert(1)">', entityLabel: "A & B <Co>" }),
    ]);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("A &amp; B &lt;Co&gt;");
  });

  it("shows the status badges, the your-turn marker and the link", () => {
    const { html } = renderQueryDigest([
      item({ awaitingYou: true, badges: [{ kind: "overdue", label: "Overdue 2 days" }], neededBy: "2026-09-17" }),
    ]);
    expect(html).toContain("Your turn");
    expect(html).toContain("Overdue 2 days");
    expect(html).toContain("needed by 2026-09-17");
    expect(html).toContain('href="https://twv-crm.vercel.app/queries?open=q1"');
  });

  it("renders one block per thread", () => {
    const { html } = renderQueryDigest([item(), item(), item()]);
    expect(html.match(/Open query/g)).toHaveLength(3);
  });
});
