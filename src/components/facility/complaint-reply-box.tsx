"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { timeAgo } from "@/lib/facility-ui";
import { MAX_REPLY_CHARS } from "@/lib/complaint-messages-shared";

export interface ComplaintReply {
  id: string;
  kind: "received" | "update" | "resolved";
  message: string | null;
  status: "sent" | "failed" | "skipped";
  detail: string | null;
  created_at: string;
}

const KIND_LABEL: Record<ComplaintReply["kind"], string> = {
  received: "Acknowledgement",
  update: "Update",
  resolved: "Closing message",
};
const STATUS_TONE: Record<ComplaintReply["status"], string> = {
  sent: "bg-emerald-100 text-emerald-800",
  failed: "bg-red-100 text-red-800",
  skipped: "bg-slate-100 text-slate-600",
};

/** What the customer has been told about this complaint, and a box to tell them more. */
export function ComplaintReplyBox({
  complaintId,
  replies,
  canSend,
  updateTemplateReady,
  onSent,
}: {
  complaintId: string;
  replies: ComplaintReply[];
  /** The complaint is still open. */
  canSend: boolean;
  updateTemplateReady: boolean;
  onSent: () => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  async function send() {
    if (!text.trim()) { toast.error("Write the message first"); return; }
    setSending(true);
    const res = await fetch(`/api/complaints/${complaintId}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text.trim() }),
    });
    setSending(false);
    const json = await res.json().catch(() => null);
    if (!res.ok) { toast.error(json?.error ?? "Could not send"); onSent(); return; }
    toast.success("Sent to the customer on WhatsApp");
    setText("");
    onSent();
  }

  return (
    <div className="mt-2 space-y-1.5">
      {replies.length > 0 && (
        <ul className="space-y-1 text-xs">
          {[...replies].sort((a, b) => a.created_at.localeCompare(b.created_at)).map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-1.5">
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${STATUS_TONE[r.status]}`}>
                {r.status === "sent" ? "Sent" : r.status === "failed" ? "Not sent" : "Skipped"}
              </span>
              <span className="font-medium">{KIND_LABEL[r.kind]}</span>
              {r.message && r.kind === "update" && <span className="text-muted-foreground">“{r.message}”</span>}
              {r.detail && r.status !== "sent" && <span className="text-muted-foreground">({r.detail})</span>}
              <span className="text-muted-foreground">· {timeAgo(r.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
      {canSend && (
        <div className="flex items-center gap-1.5">
          <Input
            value={text}
            maxLength={MAX_REPLY_CHARS}
            disabled={sending || !updateTemplateReady}
            placeholder={updateTemplateReady ? "Update the customer on WhatsApp, e.g. Technician visiting by 3 pm" : "Update template isn't approved yet"}
            className="h-8 text-xs"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void send(); }}
          />
          <Button size="sm" className="h-8" variant="outline" disabled={sending || !updateTemplateReady} onClick={send}>
            {sending ? "Sending…" : "Send"}
          </Button>
        </div>
      )}
    </div>
  );
}
