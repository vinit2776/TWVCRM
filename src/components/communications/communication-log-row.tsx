"use client";

import { useState } from "react";
import { Mail, MessageCircle, Smartphone, ChevronDown, ChevronUp, XCircle, Paperclip, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import type { CommunicationLogEntry } from "@/types";

const CHANNEL_ICONS = {
  email: Mail,
  whatsapp: MessageCircle,
  sms: Smartphone,
} as const;

const CHANNEL_LABELS = {
  email: "Email",
  whatsapp: "WhatsApp",
  sms: "SMS",
} as const;

const CHANNEL_COLORS = {
  email: "bg-blue-100 text-blue-600",
  whatsapp: "bg-green-100 text-green-600",
  sms: "bg-amber-100 text-amber-600",
} as const;

/**
 * Renders one communications_log row, collapsed by default (icon + channel +
 * recipient + status + timestamp) or expanded (+ subject + body preview +
 * attachment link). Shared verbatim across the post-send confirmation
 * modal, the inline "Recent communications" card, and the lead activity
 * timeline — same row, same look, wherever it appears.
 */
export function CommunicationLogRow({
  entry,
  defaultExpanded = false,
}: {
  entry: CommunicationLogEntry;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const Icon = CHANNEL_ICONS[entry.channel];
  const failed = entry.status === "failed";

  return (
    <div className="rounded-md border">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted/40 transition-colors"
      >
        <div className={`rounded-full p-1.5 shrink-0 ${CHANNEL_COLORS[entry.channel]}`}>
          <Icon className="h-3.5 w-3.5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className="text-xs">
              {CHANNEL_LABELS[entry.channel]}
            </Badge>
            <span className="text-sm truncate">{entry.recipient}</span>
            {failed && (
              <span className="flex items-center gap-0.5 text-xs text-red-600 shrink-0">
                <XCircle className="h-3 w-3" /> failed
              </span>
            )}
          </div>
        </div>
        <span className="text-xs text-muted-foreground shrink-0 whitespace-nowrap">
          {formatDate(entry.created_at)}
        </span>
        {expanded ? (
          <ChevronUp className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="border-t px-3 py-3 space-y-2 bg-muted/20">
          {failed && entry.error_message && (
            <p className="text-xs text-red-600">{entry.error_message}</p>
          )}
          {entry.subject && (
            <p className="text-sm font-medium">{entry.subject}</p>
          )}
          <div
            className="text-xs text-muted-foreground max-h-64 overflow-y-auto rounded border bg-background p-3"
            dangerouslySetInnerHTML={{ __html: entry.body }}
          />
          {entry.attachment_url && (
            <a
              href={entry.attachment_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              <Paperclip className="h-3 w-3" />
              {entry.attachment_name || "Open attachment"}
              <ExternalLink className="h-2.5 w-2.5" />
            </a>
          )}
        </div>
      )}
    </div>
  );
}
