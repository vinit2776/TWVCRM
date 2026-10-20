"use client";

import { useState } from "react";
import type { EnquiryDetail, EnquiryMessage } from "@/lib/enquiries";

const when = (at?: string) =>
  at ? new Date(at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "";

interface Props {
  messages: EnquiryMessage[];
  details?: EnquiryDetail[];
  /** How many of the latest messages to show before "Show all". */
  visible?: number;
}

/** What the customer asked for and wrote, so whoever picks up an enquiry can see what to answer. */
export function EnquiryContent({ messages, details = [], visible = 3 }: Props) {
  const [all, setAll] = useState(false);
  if (messages.length === 0 && details.length === 0) return null;
  const shown = all ? messages : messages.slice(-visible);
  const hidden = messages.length - shown.length;

  return (
    <div className="mt-1.5 space-y-1.5 rounded-md bg-muted/50 px-2.5 py-2">
      {details.length > 0 && (
        <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
          {details.map((d) => (
            <div key={d.label} className="flex gap-1">
              <dt className="text-muted-foreground">{d.label}:</dt>
              <dd className="font-medium">{d.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {messages.length > 0 && (
        <ul className="space-y-1 text-sm">
          {shown.map((m, i) => (
            <li key={i} className="leading-snug">
              <span className="whitespace-pre-line">“{m.text}”</span>
              {when(m.at) && <span className="ml-1.5 text-[11px] text-muted-foreground">{when(m.at)}</span>}
            </li>
          ))}
        </ul>
      )}
      {hidden > 0 && (
        <button onClick={() => setAll(true)} className="text-[11px] font-medium text-primary hover:underline">
          Show all {messages.length} messages
        </button>
      )}
      {all && messages.length > visible && (
        <button onClick={() => setAll(false)} className="text-[11px] font-medium text-primary hover:underline">
          Show fewer
        </button>
      )}
    </div>
  );
}
