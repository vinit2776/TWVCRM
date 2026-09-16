"use client";

import { useEffect, useState } from "react";
import {
  Mail, MessageCircle, Smartphone, Download, History, ChevronDown, ChevronUp, Loader2, Paperclip, ExternalLink,
} from "lucide-react";
import { formatDateTime } from "@/lib/utils";
import type { DepositHistoryItem } from "@/types";

const CHANNEL_ICONS = { email: Mail, whatsapp: MessageCircle, sms: Smartphone, manual: Download } as const;
const CHANNEL_COLORS = {
  email: "bg-blue-100 text-blue-700",
  whatsapp: "bg-green-100 text-green-700",
  sms: "bg-amber-100 text-amber-700",
  manual: "bg-violet-100 text-violet-700",
} as const;
const CHANNEL_NOUNS = { email: "Email", whatsapp: "WhatsApp", sms: "SMS", manual: "PDF" } as const;

function titleFor(item: DepositHistoryItem): string {
  if (item.source === "legacy") return "Email sent";
  if (item.channel === "manual") return "PDF downloaded to share manually";
  const noun = CHANNEL_NOUNS[item.channel];
  const verb = item.status === "failed" ? "failed" : "sent";
  if (item.source === "auto_reminder") return `Auto-reminder ${noun.toLowerCase()} ${verb}`;
  if (item.source === "manual_reminder") return `Reminder ${noun.toLowerCase()} ${verb}`;
  return `${noun} ${verb}`;
}

/**
 * Every security deposit request made for a proposal — when, how, to whom and
 * by whom — shown inside the Security Deposit card. Re-fetches whenever
 * refreshKey changes (i.e. after a send, download or reminder).
 */
export function DepositRequestHistory({ proposalId, refreshKey }: { proposalId: string; refreshKey: string }) {
  const [items, setItems] = useState<DepositHistoryItem[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/proposals/${proposalId}/deposit-history`)
      .then(async (res) => {
        const json = await res.json();
        if (cancelled) return;
        if (res.ok) {
          setItems(json.data || []);
          setError(false);
        } else {
          setError(true);
        }
      })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [proposalId, refreshKey]);

  if (error) {
    return <p className="mt-3 border-t border-amber-200 pt-3 text-xs text-red-600">Couldn&apos;t load request history.</p>;
  }
  if (items === null) {
    return (
      <div className="mt-3 flex items-center gap-2 border-t border-amber-200 pt-3 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> Loading request history…
      </div>
    );
  }
  if (items.length === 0) return null;

  return (
    <div className="mt-3 border-t border-amber-200 pt-3">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-amber-800">
        <History className="h-3.5 w-3.5" /> Request history ({items.length})
      </p>
      <div className="divide-y divide-amber-100 overflow-hidden rounded-md border border-amber-200 bg-white">
        {items.map((item) => <HistoryRow key={item.id} item={item} />)}
      </div>
    </div>
  );
}

function HistoryRow({ item }: { item: DepositHistoryItem }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = CHANNEL_ICONS[item.channel];
  const failed = item.status === "failed";
  const expandable = !!item.body;

  const meta = [
    item.sent_by_name ? `By ${item.sent_by_name}` : item.source === "auto_reminder" ? "Automatic" : null,
    item.reminder_label,
  ].filter(Boolean).join(" · ");

  return (
    <div className="px-2.5 py-2 text-xs">
      <div className="flex items-start gap-2">
        <span className={`mt-0.5 shrink-0 rounded-full p-1 ${failed ? "bg-red-100 text-red-700" : CHANNEL_COLORS[item.channel]}`}>
          <Icon className="h-3 w-3" />
        </span>
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-2">
            <span className={`font-medium ${failed ? "text-red-700" : "text-foreground"}`}>{titleFor(item)}</span>
            <span className="whitespace-nowrap text-muted-foreground">{formatDateTime(item.created_at)}</span>
          </div>

          {item.source === "legacy" ? (
            <p className="text-muted-foreground">Recipient not recorded (sent before request history was kept)</p>
          ) : item.channel === "manual" ? (
            <p className="text-muted-foreground">No email sent. Shared outside the CRM.</p>
          ) : (
            <>
              {item.recipient && (
                <p className="text-muted-foreground">To <span className="break-all font-mono text-foreground">{item.recipient}</span></p>
              )}
              {item.cc.length > 0 && (
                <p className="text-muted-foreground">Cc <span className="break-all font-mono text-foreground">{item.cc.join(", ")}</span></p>
              )}
            </>
          )}

          {failed && item.error_message && <p className="break-words text-red-600">{item.error_message}</p>}

          {(meta || expandable) && (
            <div className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
              {meta && <span>{meta}</span>}
              {expandable && (
                <button
                  type="button"
                  onClick={() => setExpanded((v) => !v)}
                  className="inline-flex items-center gap-0.5 text-primary hover:underline"
                >
                  {expanded ? "Hide" : item.channel === "email" ? "View email" : "View content"}
                  {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {expanded && item.body && (
        <div className="mt-2 space-y-1.5">
          {item.channel === "whatsapp" ? (
            <p className="rounded border bg-muted/30 p-2 whitespace-pre-wrap">{item.body}</p>
          ) : (
            <iframe
              title={`Deposit request sent ${formatDateTime(item.created_at)}`}
              srcDoc={item.body}
              sandbox=""
              className="h-80 w-full rounded border bg-white"
            />
          )}
          {item.attachment_url && (
            <a
              href={item.attachment_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              <Paperclip className="h-3 w-3" />
              {item.attachment_name || "Open attachment"}
              <ExternalLink className="h-2.5 w-2.5" />
            </a>
          )}
        </div>
      )}
    </div>
  );
}
