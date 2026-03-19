"use client";

import Link from "next/link";
import { FileText } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate } from "@/lib/utils";
import type { DashboardStats } from "@/types";

const NOTES_LS_KEY = "twv_last_seen_notes";

function getDefaultLastSeen() {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString();
}

interface NotesWidgetProps {
  stats: DashboardStats;
}

export function NotesWidget({ stats }: NotesWidgetProps) {
  const lastSeenNotes =
    typeof window !== "undefined"
      ? (localStorage.getItem(NOTES_LS_KEY) ?? getDefaultLastSeen())
      : getDefaultLastSeen();

  const unreadNotes = stats.recent_notes.filter((n) => n.created_at > lastSeenNotes);

  function markNotesSeen() {
    const now = new Date().toISOString();
    localStorage.setItem(NOTES_LS_KEY, now);
    // Force a re-render by dispatching a storage event so other tabs update too
    window.dispatchEvent(new StorageEvent("storage", { key: NOTES_LS_KEY, newValue: now }));
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div className="flex items-center gap-2">
          <CardTitle className="text-base">Unread Notes</CardTitle>
          {unreadNotes.length > 0 && (
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-bold text-white">
              {unreadNotes.length}
            </span>
          )}
        </div>
        {unreadNotes.length > 0 && (
          <button
            onClick={markNotesSeen}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors hover:underline underline-offset-2"
          >
            Mark all seen
          </button>
        )}
      </CardHeader>
      <CardContent>
        {unreadNotes.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 text-center">
            <FileText className="h-8 w-8 mb-2 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No unread notes</p>
          </div>
        ) : (
          <div className="space-y-3">
            {unreadNotes.slice(0, 5).map((note) => (
              <Link
                key={note.id}
                href={`/leads/${note.lead_id}`}
                className="flex items-start gap-3 rounded-md p-2 -mx-2 hover:bg-muted/50 transition-colors group"
              >
                <div className="rounded-full bg-amber-100 p-1.5 shrink-0 mt-0.5">
                  <FileText className="h-3 w-3 text-amber-600" />
                </div>
                <div className="flex-1 min-w-0">
                  {note.lead && (
                    <p className="text-sm font-medium truncate group-hover:underline underline-offset-2">
                      {note.lead.first_name} {note.lead.last_name}
                    </p>
                  )}
                  {note.subject && (
                    <p className="text-xs text-muted-foreground truncate">{note.subject}</p>
                  )}
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {formatDate(note.created_at)}
                  </p>
                </div>
              </Link>
            ))}
            {unreadNotes.length > 5 && (
              <p className="text-xs text-muted-foreground text-center pt-1">
                +{unreadNotes.length - 5} more
              </p>
            )}
          </div>
        )}
        <div className="mt-3 pt-3 border-t">
          <Link
            href="/activities?type=note"
            className="text-xs text-primary hover:underline underline-offset-2"
          >
            View all notes →
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
