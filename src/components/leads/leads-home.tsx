"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { FollowUpsView } from "@/components/leads/follow-ups-view";
import { PersonName } from "@/components/shared/person-name";
import { useCurrentUser } from "@/providers/current-user-provider";
import type { LeadsView } from "@/lib/leads-views";
import type { Lead } from "@/types";

export interface LeadsHomeCounts {
  overdue: number;
  dueToday: number;
  enquiries: number;
  tours: number;
  replies: number;
}

interface Props {
  counts: LeadsHomeCounts;
  users: { id: string; full_name: string; role: string }[];
  isUnread: (lead: Lead) => boolean;
  isReEnquiry: (lead: Lead) => boolean;
  onOpenLead: (lead: Lead) => void;
  onGoTo: (view: LeadsView) => void;
}

/** What needs doing now, one number each; every card opens the view that holds the work. */
function Strip({ counts, onGoTo }: Pick<Props, "counts" | "onGoTo">) {
  const cards: { label: string; n: number; view: LeadsView; tone: string }[] = [
    { label: "Overdue follow-ups", n: counts.overdue, view: "followups", tone: "text-red-700" },
    { label: "Due today", n: counts.dueToday, view: "followups", tone: "text-amber-700" },
    { label: "New enquiries", n: counts.enquiries, view: "enquiries", tone: "text-emerald-700" },
    { label: "Tours to update", n: counts.tours, view: "tours", tone: "text-violet-700" },
    { label: "Waiting on a reply", n: counts.replies, view: "replies", tone: "text-blue-700" },
  ];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {cards.map((c) => (
        <button key={c.label} type="button" onClick={() => onGoTo(c.view)} className="rounded-lg border px-3 py-2.5 text-left hover:bg-muted">
          <div className={`text-2xl font-bold ${c.n > 0 ? c.tone : "text-muted-foreground"}`}>{c.n}</div>
          <div className="text-xs text-muted-foreground">{c.label}</div>
        </button>
      ))}
    </div>
  );
}

/**
 * The Leads Home: a strip of what is waiting, then the signed-in user's follow-ups by when they
 * fall due (Today, This week, This month) with Overdue below. Admins and managers can look at
 * someone else's work; everyone else sees their own.
 */
export function LeadsHome({ counts, users, isUnread, isReEnquiry, onOpenLead, onGoTo }: Props) {
  const { user } = useCurrentUser();
  const [owner, setOwner] = useState<string | null>(null);
  if (!user?.id) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading your work…
      </div>
    );
  }
  const ownerId = owner ?? user.id;
  const canLookAtOthers = user.role === "admin" || user.role === "manager";
  const ownerName = users.find((u) => u.id === ownerId)?.full_name ?? user.full_name;
  const filters = { search: "", status: "", sources: [], locationId: null, assignedTo: ownerId, pinned: false };

  return (
    <div className="space-y-6">
      <Strip counts={counts} onGoTo={onGoTo} />

      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">
            Work for <PersonName id={ownerId} name={ownerName} />
          </h2>
          {canLookAtOthers && (
            <select
              value={ownerId}
              onChange={(e) => setOwner(e.target.value)}
              className="h-9 rounded-md border bg-background px-2 text-sm"
              aria-label="Whose work to show"
            >
              <option value={user.id}>You</option>
              {users
                .filter((u) => u.id !== user.id)
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.full_name}
                  </option>
                ))}
            </select>
          )}
        </div>
        <FollowUpsView
          key={`work-${ownerId}`}
          filters={filters}
          users={users}
          isUnread={isUnread}
          isReEnquiry={isReEnquiry}
          onOpenLead={onOpenLead}
          groups={["today", "next7", "month"]}
          initialGroup="today"
        />
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold text-red-700">Overdue</h2>
        <FollowUpsView
          key={`overdue-${ownerId}`}
          filters={filters}
          users={users}
          isUnread={isUnread}
          isReEnquiry={isReEnquiry}
          onOpenLead={onOpenLead}
          groups={["overdue"]}
          initialGroup="overdue"
        />
      </section>
    </div>
  );
}
