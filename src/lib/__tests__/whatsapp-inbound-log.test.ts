import { describe, expect, it } from "vitest";
import { GROUP_OUTCOMES, INBOUND_GROUPS, inboundGroupOf, inboundOutcomeDetail } from "@/lib/whatsapp-inbound-log";

describe("inboundGroupOf", () => {
  it("groups each stored outcome the way the log filters do", () => {
    expect(inboundGroupOf("new_lead")).toBe("new");
    expect(inboundGroupOf("re_enquiry")).toBe("re_enquiry");
    expect(inboundGroupOf("joined_open_enquiry")).toBe("follow_up");
    expect(inboundGroupOf("spam_stashed")).toBe("junk");
    expect(inboundGroupOf("held_for_review")).toBe("held");
    expect(inboundGroupOf("labelled_ignored")).toBe("ignored");
    expect(inboundGroupOf("logged_only")).toBe("other");
    expect(inboundGroupOf("intake_error")).toBe("other");
  });

  it("treats a message with no stored outcome as before tracking", () => {
    expect(inboundGroupOf(null)).toBe("untracked");
    expect(inboundGroupOf(undefined)).toBe("untracked");
  });

  it("filters on exactly the outcomes each group reports", () => {
    for (const group of INBOUND_GROUPS) {
      if (group === "untracked") continue;
      for (const outcome of GROUP_OUTCOMES[group]) expect(inboundGroupOf(outcome)).toBe(group);
    }
  });
});

describe("inboundOutcomeDetail", () => {
  it("names the enquiry a message landed on", () => {
    expect(inboundOutcomeDetail("new_lead", "TWV-E-0412")).toBe("New card TWV-E-0412");
    expect(inboundOutcomeDetail("joined_open_enquiry", "TWV-E-0398")).toBe("Added to TWV-E-0398");
  });
});
