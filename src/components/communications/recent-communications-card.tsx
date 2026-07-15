"use client";

import { useEffect, useState, useCallback } from "react";
import { Loader2, MailCheck } from "lucide-react";
import { CommunicationLogRow } from "@/components/communications/communication-log-row";
import type { CommunicationEntityType, CommunicationLogEntry } from "@/types";

/**
 * Persistent "Recent communications" section for a record page — the
 * always-visible counterpart to <CommunicationSentDialog>, so a send made
 * earlier in the day is still easy to find without digging through email.
 */
export function RecentCommunicationsCard({
  entityType,
  entityId,
  refreshKey,
}: {
  entityType: CommunicationEntityType;
  entityId: string;
  /** Bump this after a new send to refetch. */
  refreshKey?: number;
}) {
  const [entries, setEntries] = useState<CommunicationLogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/communications?entity_type=${entityType}&entity_id=${entityId}`);
      if (res.ok) {
        const json = await res.json();
        setEntries(json.data || []);
      }
    } finally {
      setLoading(false);
    }
  }, [entityType, entityId]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  if (loading) {
    return (
      <div className="text-xs text-muted-foreground flex items-center gap-1.5 px-1 py-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading communications…
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="text-xs text-muted-foreground italic py-2 flex items-center gap-1.5">
        <MailCheck className="h-3.5 w-3.5" />
        No communications sent yet.
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {entries.map((entry) => (
        <CommunicationLogRow key={entry.id} entry={entry} />
      ))}
    </div>
  );
}
