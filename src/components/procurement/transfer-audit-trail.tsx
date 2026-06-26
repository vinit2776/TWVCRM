"use client";

import {
  FileText, Send, CheckCircle2, XCircle, Truck, PackageCheck,
  AlertTriangle, ShieldCheck, Dot,
} from "lucide-react";

/**
 * TransferAuditTrail — the full who/what/when for a stock transfer, built from
 * the audit_trail records logged on every action. Shows each event, the person
 * who performed it (with role), and when.
 */

interface AuditEntry {
  id: string;
  action: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  changes: any;
  created_at: string;
  performer?: { full_name?: string | null; role?: string | null } | null;
}

const STATUS_EVENT: Record<string, { label: string; Icon: React.ElementType; color: string }> = {
  pending_approval: { label: "Submitted for approval", Icon: Send,          color: "text-blue-500" },
  approved:         { label: "Approved",                Icon: CheckCircle2, color: "text-green-600" },
  draft:            { label: "Sent back to draft",      Icon: XCircle,      color: "text-amber-600" },
  dispatched:       { label: "Dispatched",              Icon: Truck,        color: "text-indigo-500" },
  received:         { label: "Received (partial)",      Icon: PackageCheck, color: "text-teal-600" },
  completed:        { label: "Completed",               Icon: ShieldCheck,  color: "text-green-600" },
  issue_raised:     { label: "Issue raised",            Icon: AlertTriangle,color: "text-red-500" },
};

function describe(entry: AuditEntry): { label: string; Icon: React.ElementType; color: string } {
  const ch = entry.changes ?? {};
  if (entry.action === "create") {
    return { label: "Transfer created", Icon: FileText, color: "text-muted-foreground" };
  }
  const newStatus: string | undefined = ch.status?.new;
  if (newStatus && STATUS_EVENT[newStatus]) return STATUS_EVENT[newStatus];
  if (ch.issue_resolved) return { label: "Issue resolved", Icon: ShieldCheck, color: "text-green-600" };
  if (ch.issues_reported) return STATUS_EVENT.issue_raised;
  return { label: entry.action, Icon: Dot, color: "text-muted-foreground" };
}

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin", manager: "Manager", sales_rep: "Sales", floor_manager: "Floor Manager",
  accounts: "Accounts", fms: "FMS", office_admin: "Office Admin",
  it_manager: "IT Manager", it_technician: "IT Technician",
};

export function TransferAuditTrail({ entries }: { entries: AuditEntry[] }) {
  if (!entries || entries.length === 0) return null;

  const fmt = (ts: string) => {
    try {
      return new Date(ts).toLocaleString("en-IN", {
        day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit",
      });
    } catch {
      return ts;
    }
  };

  return (
    <div className="rounded-lg border bg-card p-4">
      <p className="text-sm font-medium text-muted-foreground mb-3">Audit trail</p>
      <ol className="space-y-0">
        {entries.map((e, i) => {
          const { label, Icon, color } = describe(e);
          const isLast = i === entries.length - 1;
          const who = e.performer?.full_name;
          const role = e.performer?.role ? ROLE_LABELS[e.performer.role] ?? e.performer.role : null;
          const reason = e.changes?.rejection_notes?.new || e.changes?.resolution_notes?.new;
          return (
            <li key={e.id} className="flex gap-3">
              <div className="flex flex-col items-center">
                <span className="h-7 w-7 rounded-full border bg-background flex items-center justify-center">
                  <Icon className={`h-3.5 w-3.5 ${color}`} />
                </span>
                {!isLast && <span className="w-px flex-1 bg-border my-0.5" />}
              </div>
              <div className={`min-w-0 ${isLast ? "pb-0" : "pb-4"}`}>
                <p className="text-sm font-medium leading-tight">{label}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {who ? <span className="text-foreground/80">{who}</span> : "System"}
                  {role && <span> · {role}</span>}
                  <span> · {fmt(e.created_at)}</span>
                </p>
                {reason && <p className="text-[11px] text-muted-foreground mt-0.5 italic">“{reason}”</p>}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
