// Which open WhatsApp enquiries have a customer waiting for an answer. Replies are written in the
// WhatsApp app, which the CRM cannot see, so "answered" means a person logged something on the
// enquiry (an update, or taking it on) after the customer's last message.

import { isQuietAcknowledgement } from "@/lib/whatsapp-triage";

export type ThreadMessage = { at?: string; text: string };

export type WaitingReply = {
  /** Messages since someone last acted that ask for something (acknowledgements left out). */
  count: number;
  /** "ok" / "thanks" style messages since then: counted, but they never reopen an enquiry. */
  quietCount: number;
  /** When the oldest unanswered message arrived: the clock a person is being measured against. */
  waitingSince: string;
  latestText: string;
  latestAt: string;
};

/** The minutes a customer has waited before the row turns amber, then red. Placeholders: tune with the team. */
export const REPLY_WAIT_AMBER_MINUTES = 60;
export const REPLY_WAIT_RED_MINUTES = 180;

/**
 * The customer's unanswered messages on one enquiry, or null when nothing needs a reply.
 * `lastStaffAt` is the latest update or claim; with none, nobody has picked the enquiry up, so it
 * belongs on the New tab, not here.
 */
export function waitingReply(messages: ThreadMessage[], lastStaffAt: string | null): WaitingReply | null {
  if (!lastStaffAt) return null;
  const since = messages.filter((m): m is Required<ThreadMessage> => !!m.at && m.at > lastStaffAt && !!m.text.trim());
  const real = since.filter((m) => !isQuietAcknowledgement(m.text));
  if (real.length === 0) return null;
  const latest = real[real.length - 1];
  return {
    count: real.length,
    quietCount: since.length - real.length,
    waitingSince: real[0].at,
    latestText: latest.text,
    latestAt: latest.at,
  };
}

export type WaitTone = "ok" | "amber" | "red";

export function waitTone(waitingSince: string, now: number = Date.now()): WaitTone {
  const minutes = (now - new Date(waitingSince).getTime()) / 60_000;
  if (minutes >= REPLY_WAIT_RED_MINUTES) return "red";
  if (minutes >= REPLY_WAIT_AMBER_MINUTES) return "amber";
  return "ok";
}
