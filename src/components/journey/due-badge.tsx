import { dueInfo, dueLabel } from "@/lib/journey/due";

const STYLE = {
  late: "bg-red-100 text-red-700",
  today: "bg-amber-100 text-amber-700",
  upcoming: "bg-muted text-muted-foreground",
} as const;

/** Due / late tag for an open onboarding step. Renders nothing without a due date. */
export function DueBadge({ due, className = "" }: { due?: string | null; className?: string }) {
  if (!due) return null;
  const info = dueInfo(due);
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] ${STYLE[info.state]} ${className}`} data-testid="due-badge">
      {dueLabel(due)}
    </span>
  );
}
