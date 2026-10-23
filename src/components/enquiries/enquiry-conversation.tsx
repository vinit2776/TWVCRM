"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EnquiryContent } from "@/components/enquiries/enquiry-content";
import { conversationText } from "@/lib/enquiry-row";
import type { EnquiryDetail, EnquiryMessage } from "@/lib/enquiries";

type Msg = { id: string; direction: string; message_body: string | null; template_name: string | null; created_at: string };

const when = (at: string) =>
  new Date(at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/** The chat for one enquiry, read from the WhatsApp log so it is the whole thread, not just the
 *  last 20 messages kept on the enquiry. The box is height-capped and scrolls on its own, opens at
 *  the newest message, and loads older ones on request. Enquiries with no logged chat (forms,
 *  walk-ins) fall back to what they submitted. */
export function EnquiryConversation({
  enquiryId,
  fallbackMessages,
  fallbackDetails,
}: {
  enquiryId: string;
  fallbackMessages: EnquiryMessage[];
  fallbackDetails: EnquiryDetail[];
}) {
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [failed, setFailed] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const load = useCallback(
    async (before?: string) => {
      const res = await fetch(`/api/enquiries/${enquiryId}/conversation${before ? `?before=${encodeURIComponent(before)}` : ""}`);
      if (!res.ok) {
        setFailed(true);
        return;
      }
      const json = (await res.json()) as { data: Msg[]; hasMore: boolean };
      setHasMore(json.hasMore);
      setMsgs((prev) => (before && prev ? [...json.data, ...prev] : json.data));
    },
    [enquiryId]
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Open at the newest message; keep the place when older ones are added above.
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  async function showEarlier() {
    if (!msgs?.length) return;
    const el = box.current;
    const prevHeight = el?.scrollHeight ?? 0;
    stick.current = false;
    setLoadingOlder(true);
    await load(msgs[0].created_at);
    setLoadingOlder(false);
    requestAnimationFrame(() => {
      if (el) el.scrollTop = el.scrollHeight - prevHeight;
    });
  }

  if (msgs === null && !failed) return <p className="text-xs text-muted-foreground">Loading conversation…</p>;
  if (failed || msgs?.length === 0) {
    return fallbackMessages.length > 0 || fallbackDetails.length > 0 ? (
      <EnquiryContent messages={fallbackMessages} details={fallbackDetails} visible={20} />
    ) : (
      <p className="text-xs text-muted-foreground">{failed ? "Couldn't load the conversation." : "No messages logged for this number."}</p>
    );
  }

  return (
    <div>
      <div ref={box} className="max-h-[300px] space-y-1.5 overflow-y-auto rounded-md bg-muted/50 p-2.5">
        {hasMore && (
          <button
            onClick={showEarlier}
            disabled={loadingOlder}
            className="mx-auto block text-[11px] font-medium text-primary hover:underline disabled:opacity-60"
          >
            {loadingOlder ? "Loading…" : "Show earlier"}
          </button>
        )}
        {msgs!.map((m) => {
          const mine = m.direction !== "inbound";
          return (
            <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[80%] rounded-xl border px-2.5 py-1.5 text-xs ${
                  mine ? "border-blue-200 bg-blue-50 text-blue-900" : "bg-background"
                }`}
              >
                <p className="whitespace-pre-wrap break-words">{conversationText(m)}</p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  {mine ? "Sent · " : ""}
                  {when(m.created_at)}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
