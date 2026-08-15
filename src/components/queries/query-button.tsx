"use client";

import { useCallback, useEffect, useState } from "react";
import { MessageCircleQuestion } from "lucide-react";
import { QueryThreadPanel } from "@/components/queries/query-thread-panel";

/**
 * The whole integration cost of putting queries on a new surface:
 *
 *   <QueryButton entityType="vendor_bill" entityId={bill.id} />
 *
 * Zero open threads → a quiet "Ask". One or more → a count badge. Clicking
 * expands the thread panel inline.
 */

interface Props {
  entityType: string;
  entityId: string;
  /** Pass a known count to skip the fetch — list pages usually have it already. */
  openCount?: number;
  /** Render inline under the trigger (default) or let the caller place it. */
  children?: never;
  className?: string;
  onChanged?: () => void;
}

export function QueryButton({ entityType, entityId, openCount, className, onChanged }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [count, setCount] = useState<number | null>(openCount ?? null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/queries?entity_type=${encodeURIComponent(entityType)}&entity_id=${encodeURIComponent(entityId)}`,
        { cache: "no-store" },
      );
      if (!res.ok) return;
      const json = (await res.json()) as { items: Array<{ status: string }> };
      setCount(json.items.filter((i) => i.status === "open").length);
    } catch {
      // Badge just stays as-is.
    }
  }, [entityType, entityId]);

  useEffect(() => {
    if (openCount != null) setCount(openCount);
  }, [openCount]);

  const handleChanged = useCallback(() => {
    void refresh();
    onChanged?.();
  }, [refresh, onChanged]);

  const hasOpen = (count ?? 0) > 0;

  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className={`inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded border transition-colors ${
          hasOpen
            ? "bg-amber-50 border-amber-200 text-amber-800 hover:bg-amber-100"
            : "hover:bg-muted text-muted-foreground"
        }`}
      >
        <MessageCircleQuestion className="h-3.5 w-3.5" />
        {hasOpen ? `${count} open ${count === 1 ? "query" : "queries"}` : "Ask"}
      </button>

      {expanded && (
        <div className="mt-3 pt-3 border-t">
          <QueryThreadPanel entityType={entityType} entityId={entityId} onChanged={handleChanged} />
        </div>
      )}
    </div>
  );
}
