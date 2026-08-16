"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { USER_ROLE_LABELS } from "@/lib/constants";
import { READ_ONLY_ROLES } from "@/lib/queries/audience";
import type { QueryAudience, QueryTargeting } from "@/lib/queries/types";
import type { UserRole } from "@/types";

/**
 * Who to ask.
 *
 * "Anyone who can help" is preselected and spells out who that resolves to,
 * so the common case is zero clicks and the default is never a mystery.
 * Narrowing to roles or named people is one click when it matters.
 */

interface Props {
  /** Roles authorized on this entity type — what "anyone" resolves to. */
  entityRoles: readonly UserRole[];
  /** Drives the people lookup, which is registry-aware server-side. */
  entityType: string;
  value: QueryTargeting;
  onChange: (value: QueryTargeting) => void;
  disabled?: boolean;
}

interface DirectoryUser {
  id: string;
  full_name: string;
  role: string;
}

const OPTIONS: Array<{ key: QueryAudience; label: string }> = [
  { key: "all", label: "Anyone who can help" },
  { key: "roles", label: "Specific roles" },
  { key: "users", label: "Specific people" },
];

function roleLabel(role: string): string {
  return USER_ROLE_LABELS[role] ?? role;
}

export function AudiencePicker({ entityRoles, entityType, value, onChange, disabled }: Props) {
  const [directory, setDirectory] = useState<DirectoryUser[] | null>(null);
  const [loadingDirectory, setLoadingDirectory] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(false);

  // Read-only roles can read a thread but are never routed a question, so
  // they don't belong in the picker either.
  const askableRoles = useMemo(
    () => entityRoles.filter((r) => !(READ_ONLY_ROLES as readonly string[]).includes(r)),
    [entityRoles],
  );

  const allLabel = useMemo(() => askableRoles.map(roleLabel).join(", "), [askableRoles]);

  // Only fetch the directory when someone actually wants to name a person.
  useEffect(() => {
    if (value.audience !== "users" || directory || loadingDirectory) return;
    setLoadingDirectory(true);
    fetch(`/api/queries/directory?entity_type=${encodeURIComponent(entityType)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
      .then((json) => setDirectory((json.users ?? []) as DirectoryUser[]))
      .catch(() => setDirectory([]))
      .finally(() => setLoadingDirectory(false));
  }, [value.audience, directory, loadingDirectory, entityType]);

  const askablePeople = directory ?? [];

  function select(audience: QueryAudience) {
    onChange({
      audience,
      audience_roles: audience === "roles" ? value.audience_roles : [],
      audience_user_ids: audience === "users" ? value.audience_user_ids : [],
    });
    if (audience === "users") setPeopleOpen(true);
  }

  function toggleRole(role: UserRole) {
    const next = value.audience_roles.includes(role)
      ? value.audience_roles.filter((r) => r !== role)
      : [...value.audience_roles, role];
    onChange({ ...value, audience: "roles", audience_roles: next, audience_user_ids: [] });
  }

  function toggleUser(id: string) {
    const next = value.audience_user_ids.includes(id)
      ? value.audience_user_ids.filter((u) => u !== id)
      : [...value.audience_user_ids, id];
    onChange({ ...value, audience: "users", audience_user_ids: next, audience_roles: [] });
  }

  return (
    <div className="space-y-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Ask</div>

      {OPTIONS.map((opt) => {
        const active = value.audience === opt.key;
        return (
          <div key={opt.key}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => select(opt.key)}
              className="flex items-center gap-2 text-sm py-0.5 disabled:opacity-50 w-full text-left"
            >
              {/* Ring + inner dot rather than a fat border: `border` and
                  `border-[5px]` on the same element resolve by stylesheet
                  order, not class order, so the thick-border version silently
                  rendered at 1px and the selected option looked identical to
                  the unselected ones. */}
              <span
                aria-hidden
                className={`h-3.5 w-3.5 rounded-full border-2 flex-none grid place-items-center ${
                  active ? "border-foreground" : "border-muted-foreground/40"
                }`}
              >
                {active && <span className="h-1.5 w-1.5 rounded-full bg-foreground" />}
              </span>
              <span className={active ? "font-medium" : ""}>{opt.label}</span>
              {opt.key === "all" && active && (
                <span className="text-xs text-muted-foreground truncate">— {allLabel}</span>
              )}
            </button>

            {active && opt.key === "roles" && (
              <div className="flex flex-wrap gap-1.5 pl-5.5 mt-1.5 ml-5">
                {askableRoles.map((role) => {
                  const on = value.audience_roles.includes(role);
                  return (
                    <button
                      key={role}
                      type="button"
                      disabled={disabled}
                      onClick={() => toggleRole(role)}
                      className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded border transition-colors ${
                        on
                          ? "bg-foreground text-background border-foreground"
                          : "hover:bg-muted border-dashed text-muted-foreground"
                      }`}
                    >
                      {on && <Check className="h-3 w-3" />}
                      {roleLabel(role)}
                    </button>
                  );
                })}
              </div>
            )}

            {active && opt.key === "users" && (
              <div className="mt-1.5 ml-5 space-y-1.5">
                <div className="flex flex-wrap gap-1.5">
                  {value.audience_user_ids.map((id) => {
                    const u = askablePeople.find((p) => p.id === id);
                    return (
                      <button
                        key={id}
                        type="button"
                        disabled={disabled}
                        onClick={() => toggleUser(id)}
                        className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border bg-foreground text-background border-foreground"
                      >
                        <Check className="h-3 w-3" />
                        {u?.full_name ?? "Selected"}
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => setPeopleOpen((o) => !o)}
                    className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-dashed text-muted-foreground hover:bg-muted"
                  >
                    {loadingDirectory ? <Loader2 className="h-3 w-3 animate-spin" /> : <ChevronDown className="h-3 w-3" />}
                    Add person
                  </button>
                </div>

                {peopleOpen && (
                  <div className="border rounded-md max-h-44 overflow-y-auto divide-y bg-background">
                    {askablePeople.length === 0 && !loadingDirectory && (
                      <p className="text-xs text-muted-foreground p-2">No one available to ask here.</p>
                    )}
                    {askablePeople.map((u) => {
                      const on = value.audience_user_ids.includes(u.id);
                      return (
                        <button
                          key={u.id}
                          type="button"
                          onClick={() => toggleUser(u.id)}
                          className="flex items-center justify-between w-full text-left px-2.5 py-1.5 text-xs hover:bg-muted"
                        >
                          <span>
                            {u.full_name}{" "}
                            <span className="text-muted-foreground">· {roleLabel(u.role)}</span>
                          </span>
                          {on && <Check className="h-3.5 w-3.5" />}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
