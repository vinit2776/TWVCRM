import { describe, it, expect } from "vitest";
import { classifyByRules, decideGrouping, type TriageContext } from "../whatsapp-triage";

const NEW_NUMBER: TriageContext = { hasActiveContract: false, leadStatus: null, hasReferral: false, knownSender: false, hasOpenEnquiry: false };
const k = (text: string, ctx: Partial<TriageContext> = {}, type = "text") => classifyByRules(text, type, { ...NEW_NUMBER, ...ctx }).kind;

describe("classifyByRules", () => {
  it("treats an ad reply as an enquiry even if short", () => {
    expect(k("Hi", { hasReferral: true })).toBe("enquiry");
  });
  it("recognises enquiry wording from a new number", () => {
    expect(k("Hello, do you have private cabins for 5 people? What is the price")).toBe("enquiry");
    expect(k("Looking for a meeting room on Friday")).toBe("enquiry");
  });
  it("flags scam wording as spam, but never when the message replies to an ad", () => {
    expect(k("You have won a lottery prize! click link http://bit.ly/x")).toBe("spam");
    expect(k("Earn money from home with bitcoin trading signals")).toBe("spam");
    expect(k("You won a prize http://bit.ly/x", { hasReferral: true })).toBe("enquiry");
  });
  it("a customer with an active contract is never an enquiry for ordinary messages", () => {
    expect(k("AC not working in cabin 4", { hasActiveContract: true, knownSender: true })).toBe("complaint");
    expect(k("Can you resend the invoice", { hasActiveContract: true, knownSender: true })).toBe("complaint");
    expect(k("Thanks, will pay tomorrow", { hasActiveContract: true, knownSender: true })).toBe("customer");
  });
  it("sends a customer asking about more space to review, not auto", () => {
    expect(k("We need 3 more seats, what is the price", { hasActiveContract: true, knownSender: true })).toBe("unsure");
  });
  it("a bare acknowledgement is low signal for a known sender, unclear from a new number", () => {
    expect(k("ok thanks", { knownSender: true, hasOpenEnquiry: true })).toBe("low_signal");
    expect(k("", { knownSender: true }, "sticker")).toBe("low_signal");
    expect(k("hi")).toBe("unsure");
  });
  it("a number marked spam before stays spam unless it now reads like an enquiry", () => {
    expect(k("buy now", { leadStatus: "junk", knownSender: true })).toBe("spam");
    expect(k("I need a cabin for 4 seats", { leadStatus: "junk", knownSender: true })).toBe("unsure");
  });
  it("gives up honestly when it cannot tell", () => {
    expect(k("Is this Rahul's number?")).toBe("unsure");
  });
});

describe("decideGrouping", () => {
  const NOW = new Date("2026-11-10T12:00:00Z");
  const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
  const open = (over: Partial<Parameters<typeof decideGrouping>[0] & object> = {}) => ({
    resolved_at: null, resolution_outcome: null, claimed: false, hasNextStep: false, last_touch_at: days(1), ...over,
  });
  it("no earlier enquiry means a new one", () => {
    expect(decideGrouping(null, NOW)).toBe("new");
  });
  it("joins an open enquiry that is recent, measured from the LAST message not the first", () => {
    expect(decideGrouping(open({ last_touch_at: days(2) }), NOW)).toBe("join");
    expect(decideGrouping(open({ last_touch_at: days(4) }), NOW)).toBe("new");
  });
  it("keeps a claimed or planned enquiry as the live conversation for longer", () => {
    expect(decideGrouping(open({ claimed: true, last_touch_at: days(6) }), NOW)).toBe("join");
    expect(decideGrouping(open({ hasNextStep: true, last_touch_at: days(8) }), NOW)).toBe("new");
  });
  it("a converted customer writing again is a customer message; other closed enquiries start a new one", () => {
    expect(decideGrouping(open({ resolved_at: days(2), resolution_outcome: "converted" }), NOW)).toBe("customer_message");
    expect(decideGrouping(open({ resolved_at: days(2), resolution_outcome: "not_interested" }), NOW)).toBe("new");
    expect(decideGrouping(open({ resolved_at: days(40), resolution_outcome: "no_response" }), NOW)).toBe("new");
  });
});

import { parseAiReply } from "../whatsapp-triage-ai";

describe("parseAiReply", () => {
  it("maps a confident reply and keeps the reason", () => {
    expect(parseAiReply('{"kind":"support","confidence":0.9,"reason":"reports a broken light"}')).toEqual({
      kind: "complaint", reason: "AI: reports a broken light", source: "ai",
    });
  });
  it("ignores low confidence, unknown kinds, 'other' and garbage so the message stays unsure", () => {
    expect(parseAiReply('{"kind":"spam","confidence":0.4,"reason":"x"}')).toBeNull();
    expect(parseAiReply('{"kind":"other","confidence":0.95,"reason":"x"}')).toBeNull();
    expect(parseAiReply('{"kind":"enquiry"}')).toBeNull();
    expect(parseAiReply("not json")).toBeNull();
  });
  it("tolerates text around the JSON", () => {
    expect(parseAiReply('Sure: {"kind":"enquiry","confidence":0.8,"reason":"asks about price"} done')?.kind).toBe("enquiry");
  });
});
