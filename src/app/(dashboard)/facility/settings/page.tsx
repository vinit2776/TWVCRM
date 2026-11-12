"use client";
/**
 * Facility Settings — admin/it_manager/it_team only.
 *
 * Two sections:
 *   1. Departments — one row per scope, each with an auto-assign head
 *      (drives Work Order auto-assignment when a category has no more
 *      specific default_assignee_id) and a member roster (informational).
 *   2. Categories & TAT defaults — per-category default assignee +
 *      the 4 priority-tiered TAT hour defaults used to compute new
 *      Work Orders' deadlines.
 */

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, Users, Save, AlertTriangle, Ban, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { SCOPE_LABEL } from "@/lib/facility-ui";
import { FACILITY_ROLES, hasRole } from "@/lib/facility";
import type { FacilityAssetCategory, FacilityDepartment } from "@/types";
import { PageBreadcrumb } from "@/components/page-breadcrumb";

interface Assignee { id: string; full_name: string; email: string; role: string }
interface CurrentUser { id: string; role: string }

const NONE = "__none__";

export default function FacilitySettingsPage() {
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [departments, setDepartments] = useState<FacilityDepartment[]>([]);
  const [categories, setCategories] = useState<FacilityAssetCategory[]>([]);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [rosterDept, setRosterDept] = useState<FacilityDepartment | null>(null);
  const [rosterSelection, setRosterSelection] = useState<Set<string>>(new Set());
  const [savingRoster, setSavingRoster] = useState(false);
  const [catDrafts, setCatDrafts] = useState<Record<string, {
    name: string;
    default_assignee_id: string;
    default_sla_critical_hrs: string;
    default_sla_high_hrs: string;
    default_sla_medium_hrs: string;
    default_sla_low_hrs: string;
  }>>({});
  const [savingCatId, setSavingCatId] = useState<string | null>(null);
  const [togglingCatId, setTogglingCatId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [deptRes, catRes, assigneeRes] = await Promise.all([
        fetch("/api/facility/departments").then((r) => r.json()),
        fetch("/api/facility/categories?include_all=true&include_inactive=true").then((r) => r.json()),
        fetch("/api/facility/assignees").then((r) => r.json()),
      ]);
      const depts: FacilityDepartment[] = deptRes.data ?? [];
      const cats: FacilityAssetCategory[] = catRes.data ?? [];
      setDepartments(depts);
      setCategories(cats);
      setAssignees(assigneeRes.data ?? []);
      setCatDrafts(Object.fromEntries(cats.map((c) => [c.id, {
        name: c.name,
        default_assignee_id: c.default_assignee_id ?? "",
        default_sla_critical_hrs: String(c.default_sla_critical_hrs ?? ""),
        default_sla_high_hrs: String(c.default_sla_high_hrs ?? ""),
        default_sla_medium_hrs: String(c.default_sla_medium_hrs ?? ""),
        default_sla_low_hrs: String(c.default_sla_low_hrs ?? ""),
      }])));
    } catch {
      toast.error("Failed to load facility settings");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetch("/api/me").then((r) => r.json()).then((j) => setCurrentUser(j ?? null)).catch(() => null);
    load();
  }, []);

  const allowed = hasRole(currentUser?.role, FACILITY_ROLES.manage);

  const setDeptHead = async (dept: FacilityDepartment, headUserId: string | null) => {
    const res = await fetch(`/api/facility/departments/${dept.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ head_user_id: headUserId }),
    });
    const json = await res.json();
    if (!res.ok) {
      toast.error(json.error || "Failed to update department head");
      return;
    }
    toast.success(`${SCOPE_LABEL[dept.scope]} head updated`);
    load();
  };

  const openRoster = (dept: FacilityDepartment) => {
    setRosterDept(dept);
    setRosterSelection(new Set((dept.members ?? []).map((m) => m.user_id)));
  };

  const saveRoster = async () => {
    if (!rosterDept) return;
    setSavingRoster(true);
    const current = new Set((rosterDept.members ?? []).map((m) => m.user_id));
    const toAdd = [...rosterSelection].filter((id) => !current.has(id));
    const toRemove = [...current].filter((id) => !rosterSelection.has(id));
    try {
      if (toAdd.length) {
        await fetch(`/api/facility/departments/${rosterDept.id}/members`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_ids: toAdd }),
        });
      }
      for (const userId of toRemove) {
        await fetch(`/api/facility/departments/${rosterDept.id}/members`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id: userId }),
        });
      }
      toast.success("Roster updated");
      setRosterDept(null);
      load();
    } catch {
      toast.error("Failed to update roster");
    } finally {
      setSavingRoster(false);
    }
  };

  const saveCategory = async (cat: FacilityAssetCategory) => {
    const draft = catDrafts[cat.id];
    if (!draft) return;
    if (!draft.name.trim()) {
      toast.error("Category name can't be empty");
      return;
    }
    setSavingCatId(cat.id);
    try {
      const assigneeRes = await fetch(`/api/facility/categories/${cat.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          default_assignee_id: draft.default_assignee_id || null,
          backup_assignee_id: null,
        }),
      });
      const slaRes = await fetch(`/api/facility/categories/${cat.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name.trim(),
          default_sla_critical_hrs: Number(draft.default_sla_critical_hrs) || 0,
          default_sla_high_hrs: Number(draft.default_sla_high_hrs) || 0,
          default_sla_medium_hrs: Number(draft.default_sla_medium_hrs) || 0,
          default_sla_low_hrs: Number(draft.default_sla_low_hrs) || 0,
        }),
      });
      if (!assigneeRes.ok || !slaRes.ok) throw new Error();
      toast.success(`${draft.name.trim()} defaults saved`);
      load();
    } catch {
      toast.error("Failed to save category defaults");
    } finally {
      setSavingCatId(null);
    }
  };

  const toggleCategoryActive = async (cat: FacilityAssetCategory) => {
    setTogglingCatId(cat.id);
    try {
      const res = cat.is_active
        ? await fetch(`/api/facility/categories/${cat.id}`, { method: "DELETE" })
        : await fetch(`/api/facility/categories/${cat.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ is_active: true }),
          });
      if (!res.ok) throw new Error();
      toast.success(cat.is_active ? `${cat.name} deactivated` : `${cat.name} reactivated`);
      load();
    } catch {
      toast.error(cat.is_active ? "Failed to deactivate category" : "Failed to reactivate category");
    } finally {
      setTogglingCatId(null);
    }
  };

  if (loading) {
    return <div className="p-6 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  if (!allowed) {
    return (
      <div className="p-6 max-w-lg mx-auto text-center text-sm text-muted-foreground">
        Facility Settings is restricted to Admin, IT Manager and IT Team.
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-8">
      <PageBreadcrumb resetTo={{ label: "Facility Settings" }} />
      <div>
        <h1 className="text-xl md:text-2xl font-semibold">Facility Settings</h1>
        <p className="text-xs md:text-sm text-muted-foreground">
          Department auto-assignment and Work Order TAT defaults
        </p>
      </div>

      {/* ───── Departments ──────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Departments</h2>
        <p className="text-xs text-muted-foreground -mt-2">
          A Work Order auto-assigns to its category&apos;s default assignee first; if that&apos;s not set, it falls back to the department head below. With neither set, it&apos;s left for manual claim.
        </p>
        <div className="rounded-lg border divide-y">
          {departments.map((dept) => (
            <div key={dept.id} className="flex items-center gap-3 p-3">
              <div className="w-32 shrink-0 text-sm font-medium flex items-center gap-1.5">
                {SCOPE_LABEL[dept.scope]}
                {!dept.head_user_id && (
                  <AlertTriangle
                    className="h-3.5 w-3.5 text-amber-500 shrink-0"
                    aria-label="No department head — tickets here go unclaimed until someone manually picks them up"
                  />
                )}
              </div>
              <div className="flex-1">
                <Select
                  value={dept.head_user_id ?? NONE}
                  onValueChange={(v) => setDeptHead(dept, v === NONE ? null : v)}
                >
                  <SelectTrigger className="h-8 max-w-xs">
                    <SelectValue placeholder="No head assigned" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>No head (manual assignment)</SelectItem>
                    {assignees.map((a) => (
                      <SelectItem key={a.id} value={a.id}>{a.full_name} ({a.role})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!dept.head_user_id && (
                  <p className="text-[11px] text-amber-600 mt-1">
                    No head assigned — Work Orders routed here won&apos;t auto-assign and will sit unclaimed.
                  </p>
                )}
              </div>
              <Button variant="outline" size="sm" onClick={() => openRoster(dept)}>
                <Users className="h-3.5 w-3.5 mr-1.5" />
                {dept.members?.length ?? 0} member{(dept.members?.length ?? 0) === 1 ? "" : "s"}
              </Button>
            </div>
          ))}
        </div>
      </section>

      {/* ───── Categories & TAT defaults ────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Categories &amp; TAT defaults</h2>
        <p className="text-xs text-muted-foreground -mt-2">
          Default assignee (most specific — overrides the department head above) and TAT hours per priority, used to compute a new Work Order&apos;s deadline unless manually overridden at creation. Rename a category directly in its name field, then hit save. Deactivating hides it from pickers for new assets/issues — existing assets and issues keep it and are unaffected; reactivate any time.
        </p>
        <div className="rounded-lg border divide-y">
          {categories.map((cat) => {
            const draft = catDrafts[cat.id];
            if (!draft) return null;
            return (
              <div key={cat.id} className={`p-3 space-y-2 ${!cat.is_active ? "opacity-60" : ""}`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <Input
                      value={draft.name}
                      onChange={(e) => setCatDrafts((prev) => ({
                        ...prev, [cat.id]: { ...prev[cat.id], name: e.target.value },
                      }))}
                      className="h-8 max-w-[220px] text-sm font-medium"
                    />
                    <span className="text-xs text-muted-foreground shrink-0">({SCOPE_LABEL[cat.scope]})</span>
                    {!cat.is_active && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground shrink-0">Inactive</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Button size="sm" variant="outline" disabled={savingCatId === cat.id} onClick={() => saveCategory(cat)} title="Save changes">
                      {savingCatId === cat.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={togglingCatId === cat.id}
                      onClick={() => toggleCategoryActive(cat)}
                      title={cat.is_active ? "Deactivate category" : "Reactivate category"}
                    >
                      {togglingCatId === cat.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : cat.is_active ? (
                        <Ban className="h-3.5 w-3.5 text-destructive" />
                      ) : (
                        <RotateCcw className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </div>
                </div>
                <div className="flex flex-wrap items-end gap-3">
                  <div className="space-y-1">
                    <Label className="text-[11px] text-muted-foreground">Default assignee</Label>
                    <Select
                      value={draft.default_assignee_id || NONE}
                      onValueChange={(v) => setCatDrafts((prev) => ({
                        ...prev, [cat.id]: { ...prev[cat.id], default_assignee_id: v === NONE ? "" : v },
                      }))}
                    >
                      <SelectTrigger className="h-8 w-48">
                        <SelectValue placeholder="Unset" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>Unset (use department head)</SelectItem>
                        {assignees.map((a) => (
                          <SelectItem key={a.id} value={a.id}>{a.full_name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {([
                    ["default_sla_critical_hrs", "Critical (h)"],
                    ["default_sla_high_hrs", "High (h)"],
                    ["default_sla_medium_hrs", "Medium (h)"],
                    ["default_sla_low_hrs", "Low (h)"],
                  ] as const).map(([field, label]) => (
                    <div key={field} className="space-y-1">
                      <Label className="text-[11px] text-muted-foreground">{label}</Label>
                      <Input
                        type="number" min={0} step={1} className="h-8 w-20"
                        value={draft[field]}
                        onChange={(e) => setCatDrafts((prev) => ({
                          ...prev, [cat.id]: { ...prev[cat.id], [field]: e.target.value },
                        }))}
                      />
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ───── Roster dialog ────────────────────────────────────────────── */}
      <Dialog open={!!rosterDept} onOpenChange={(o) => !o && setRosterDept(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{rosterDept && SCOPE_LABEL[rosterDept.scope]} roster</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground -mt-2">
            Informational only — membership doesn&apos;t restrict who can claim a ticket, but members are suggested first when adding collaborators.
          </p>
          <div className="max-h-80 overflow-y-auto space-y-1">
            {assignees.map((a) => {
              const checked = rosterSelection.has(a.id);
              return (
                <label key={a.id} className="flex items-center gap-2 p-1.5 rounded hover:bg-muted/40 text-sm cursor-pointer">
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(v) => {
                      setRosterSelection((prev) => {
                        const next = new Set(prev);
                        if (v) next.add(a.id); else next.delete(a.id);
                        return next;
                      });
                    }}
                  />
                  {a.full_name} <span className="text-xs text-muted-foreground">({a.role})</span>
                </label>
              );
            })}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRosterDept(null)}>Cancel</Button>
            <Button onClick={saveRoster} disabled={savingRoster}>
              {savingRoster && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save roster
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
