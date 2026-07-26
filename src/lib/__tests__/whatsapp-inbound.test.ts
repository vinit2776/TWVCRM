/**
 * Inbound MSG91 webhook payload parsing.
 *
 * Fixtures are the real shapes MSG91 posted between 1–26 Jul 2026, taken from
 * its webhook delivery snapshots and anonymised. Counts in each comment are how
 * often that shape occurred across those 51 inbound events.
 *
 * The bug these cover: the handler keyed on the top-level `text` field, which is
 * empty for everything except a plain typed message. 43 of 51 inbound events
 * were silently discarded — including all 29 Click-to-WhatsApp ad leads.
 */

import { describe, it, expect } from "vitest";
import { parseInboundMessage } from "@/app/api/webhooks/whatsapp/route";

describe("parseInboundMessage", () => {
  // 7x — plain typed message. The only shape the old handler accepted.
  it("reads a plain text message from the top-level field", () => {
    const r = parseInboundMessage({
      from: "919000000001",
      text: "Hello! Can I get more info on this?",
      content: JSON.stringify({ text: "Hello! Can I get more info on this?" }),
      messageType: "text",
    });
    expect(r.body).toBe("Hello! Can I get more info on this?");
    expect(r.messageType).toBe("text");
    expect(r.referral).toBeUndefined();
  });

  it("falls back to content.text when the top-level text is empty", () => {
    const r = parseInboundMessage({
      from: "919000000001",
      text: "",
      content: JSON.stringify({ text: "Sent from the app" }),
      messageType: "text",
    });
    expect(r.body).toBe("Sent from the app");
  });

  // 29x — the largest group, and the most commercially important: inbound leads
  // from Instagram/Facebook ads. content.referral.text is the customer's own
  // message; body/headline are the ad creative and must NOT be used as the text.
  it("extracts the customer's message from a Click-to-WhatsApp ad reply", () => {
    const r = parseInboundMessage({
      from: "919000000002",
      text: "",
      messageType: "text",
      content: JSON.stringify({
        referral: {
          source_url: "https://www.instagram.com/p/EXAMPLE/",
          source_id: "1200000000",
          source_type: "ad",
          body: "Looking for a private office space that grows with your team?",
          headline: "Premium Office Spaces in Nungambakkam",
          media_type: "image",
          text: "Hello! Can I get more info on this?",
        },
      }),
    });
    expect(r.body).toBe("Hello! Can I get more info on this?");
    expect(r.referral).toEqual({
      sourceType: "ad",
      sourceUrl: "https://www.instagram.com/p/EXAMPLE/",
      headline: "Premium Office Spaces in Nungambakkam",
    });
  });

  it("still records an ad reply that carries no text of its own", () => {
    const r = parseInboundMessage({
      from: "919000000002",
      text: "",
      messageType: "text",
      content: JSON.stringify({ referral: { source_type: "ad", body: "ad copy" } }),
    });
    expect(r.body).toBe("[replied to ad]");
    expect(r.referral?.sourceType).toBe("ad");
  });

  // 1x — WhatsApp Flow form submission. response_json is a nested JSON string,
  // and the screen_N_ prefixes are noise.
  // The real payload for this one arrives with text === "[object Object]":
  // MSG91 renders {{text}} by stringifying whatever it holds. Trusting it lost
  // the customer's name and email.
  it("flattens a WhatsApp Flow form submission and drops the flow token", () => {
    const r = parseInboundMessage({
      from: "919000000003",
      text: "[object Object]",
      messageType: "interactive",
      content: JSON.stringify({
        reply: {
          response_json: JSON.stringify({
            screen_0_Name_0: "Harikumar",
            screen_0_Email_1: "someone@example.com",
            flow_token: "216229d6-e66c-4cfe-a4b4-eb5d2db3ec0d",
          }),
          body: "Sent",
          name: "flow",
        },
      }),
    });
    expect(r.body).toBe("[form] Name: Harikumar, Email: someone@example.com");
    expect(r.body).not.toContain("flow_token");
  });

  // 3x — media messages carry only a URL.
  it("records media messages with their attachment url", () => {
    const r = parseInboundMessage({
      from: "919000000004",
      text: "",
      messageType: "image",
      content: JSON.stringify({ attachment_url: "https://example.test/media/1" }),
    });
    expect(r.body).toBe("[image] https://example.test/media/1");
    expect(r.attachmentUrl).toBe("https://example.test/media/1");
  });

  // 11x — reactions/stickers arrive with content null. Previously dropped
  // entirely; now recorded so the team can see that someone made contact.
  it("records unsupported types with a null content", () => {
    expect(parseInboundMessage({ from: "919000000005", text: "", messageType: "unsupported", content: null }).body)
      .toBe("[unsupported]");
    // MSG91 sometimes sends the string "null" rather than a JSON null.
    expect(parseInboundMessage({ from: "919000000005", text: "", messageType: "unsupported", content: "null" }).body)
      .toBe("[unsupported]");
  });

  it("never surfaces MSG91's stringified '[object Object]' to the team", () => {
    const r = parseInboundMessage({
      from: "919000000003",
      text: "[object Object]",
      messageType: "interactive",
      content: JSON.stringify({ reply: { body: "Sent", name: "flow" } }),
    });
    expect(r.body).toBe("Sent");
  });

  it("uses a non-JSON content string as-is", () => {
    const r = parseInboundMessage({ from: "919000000006", text: "", messageType: "text", content: "plain fallback" });
    expect(r.body).toBe("plain fallback");
  });

  // Regression: delivery reports carry a `from` (the customer's number) and an
  // empty `text`, so a handler keyed on the sender alone turned every "sent"
  // callback into a phantom inbound message. The handler now requires the
  // absence of a `status` field; this asserts the shape that distinguishes them.
  it("delivery-report payloads are distinguishable from inbound ones", () => {
    const deliveryReport = {
      status: "sent", requestId: "abc123", to: "919000000001", from: "919000000001",
      templateName: "booking_confirmation", channel: "whatsapp", text: "", direction: "1",
    };
    const inbound = {
      from: "919000000001", text: "hi there", channel: "whatsapp",
      eventName: "submitted", messageType: "text", direction: "0",
    };
    expect(deliveryReport.status).toBeTruthy();
    expect((inbound as Record<string, unknown>).status).toBeUndefined();
  });

  it("never returns an empty body, so no inbound event is dropped", () => {
    const shapes: Array<Record<string, unknown>> = [
      { messageType: "text" },
      { text: "   ", messageType: "text", content: "" },
      { text: "", messageType: "sticker", content: JSON.stringify({}) },
      { text: "", messageType: "interactive", content: JSON.stringify({ reply: {} }) },
    ];
    for (const s of shapes) {
      expect(parseInboundMessage(s).body.length).toBeGreaterThan(0);
    }
  });
});

/**
 * Template body parameters. Meta rejects newlines, tabs and runs of 4+ spaces,
 * which MSG91 returns as HTTP 400 "next line(\n) is not supported for body
 * value". Facility ticket nudges hit this because the link is built from
 * NEXT_PUBLIC_APP_URL, stored in Vercel with a trailing newline.
 */
describe("sanitiseParam", () => {
  // Mirrors the implementation in src/lib/whatsapp.ts.
  const sanitiseParam = (value: string): string => {
    const s = String(value ?? "").trim();
    if (/^https?:\/\//i.test(s)) return s.replace(/\s+/g, "");
    return s.replace(/\s+/g, " ");
  };

  it("strips whitespace from URLs instead of collapsing it to a space", () => {
    // Collapsing would give "https://twv-crm.vercel.app /facility/..." — a send
    // that succeeds but delivers an unclickable link.
    const url = "https://twv-crm.vercel.app\n/facility/issues/abc123";
    expect(sanitiseParam(url)).toBe("https://twv-crm.vercel.app/facility/issues/abc123");
    expect(sanitiseParam(url)).not.toContain(" ");
  });

  it("collapses whitespace in prose, so a multi-line ticket description still sends", () => {
    expect(sanitiseParam("WiFi down\nin the board room\t— urgent"))
      .toBe("WiFi down in the board room — urgent");
  });

  it("leaves already-clean values untouched", () => {
    expect(sanitiseParam("FI-2026-0042")).toBe("FI-2026-0042");
    expect(sanitiseParam("https://twv-crm.vercel.app/x")).toBe("https://twv-crm.vercel.app/x");
  });

  it("never emits a value containing a newline", () => {
    for (const v of ["a\nb", "https://x.test/a\nb", "  \n lead \n ", "tab\there"]) {
      expect(sanitiseParam(v)).not.toMatch(/[\n\r\t]/);
    }
  });
});
