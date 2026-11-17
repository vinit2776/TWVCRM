"use client";

import { useState } from "react";
import { UserRound, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LEAD_HANDLER_ROLES } from "@/lib/constants";
import type { Lead } from "@/types";

type UserOption = { id: string; full_name: string; role: string };

async function assign(leadId: string, assignedTo?: string) {
  const res = await fetch(`/api/leads/${leadId}/assign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(assignedTo ? { assigned_to: assignedTo } : {}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "Could not change who handles this lead");
  }
}

/**
 * Who is handling this lead, visible to everyone. An unhandled lead shows a red "Claim" button that
 * takes it in one tap; a handled one shows the name, and opens a list to hand it to someone else.
 * The server decides who is allowed to; this only offers the choice.
 */
export function LeadHandlerChip({
  lead,
  users,
  onChanged,
}: {
  lead: Lead;
  users: UserOption[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const handler = lead.assigned_user?.full_name ?? null;

  const run = async (assignedTo: string | undefined, done: string) => {
    setBusy(true);
    try {
      await assign(lead.id, assignedTo);
      toast.success(done);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  };

  if (lead.archived_at) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <UserRound className="h-3 w-3" />
        {handler ?? "Unassigned"}
      </span>
    );
  }

  if (!handler) {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          void run(undefined, "You're now handling this lead");
        }}
        className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-60"
      >
        <UserRound className="h-3 w-3" />
        Unassigned · Claim
      </button>
    );
  }

  const options = users.filter(
    (u) => (LEAD_HANDLER_ROLES as readonly string[]).includes(u.role) && u.id !== lead.assigned_to,
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={busy}
        onClick={(e) => e.stopPropagation()}
        className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-foreground hover:bg-muted/70 disabled:opacity-60"
      >
        <UserRound className="h-3 w-3" />
        {handler}
        <ChevronDown className="h-3 w-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuLabel>Hand this lead to</DropdownMenuLabel>
        {options.length === 0 && <div className="px-2 py-1.5 text-sm text-muted-foreground">No one else available</div>}
        {options.map((u) => (
          <DropdownMenuItem key={u.id} onSelect={() => void run(u.id, `Now handled by ${u.full_name}`)}>
            {u.full_name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
