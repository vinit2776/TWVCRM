"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { Plus, Pencil, Trash2, Loader2, Calendar, Clock, Shield, Info, AlertTriangle } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface AccessProfile {
  id: string;
  name: string;
  description: string | null;
  allowed_days: number[];
  from_time: string | null;
  until_time: string | null;
  cosec_user_group: number;
  is_default: boolean;
  created_at: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DAYS = [
  { value: 0, label: "Sun" },
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
];

const DEFAULT_FORM = {
  name: "",
  description: "",
  allowed_days: [1, 2, 3, 4, 5] as number[],
  from_time: "08:00",
  until_time: "22:00",
  cosec_user_group: 0,
  is_default: false,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDays(days: number[]): string {
  const sorted = [...days].sort((a, b) => a - b);
  if (sorted.length === 7) return "All days";
  if (JSON.stringify(sorted) === JSON.stringify([1, 2, 3, 4, 5])) return "Mon – Fri";
  if (JSON.stringify(sorted) === JSON.stringify([0, 6])) return "Sat & Sun";
  return sorted.map(d => DAYS[d].label).join(", ");
}

function formatTime(t: string | null): string {
  if (!t) return "Any";
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${ampm}`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function AccessProfilesPage() {
  const [profiles, setProfiles]   = useState<AccessProfile[]>([]);
  const [loading, setLoading]     = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing]     = useState<AccessProfile | null>(null);
  const [form, setForm]           = useState(DEFAULT_FORM);
  const [saving, setSaving]       = useState(false);
  const [deleting, setDeleting]   = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/cosec/access-profiles");
    if (res.ok) setProfiles(await res.json());
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  function openCreate() {
    setEditing(null);
    setForm(DEFAULT_FORM);
    setDialogOpen(true);
  }

  function openEdit(p: AccessProfile) {
    setEditing(p);
    setForm({
      name: p.name,
      description: p.description ?? "",
      allowed_days: p.allowed_days,
      from_time: p.from_time ?? "",
      until_time: p.until_time ?? "",
      cosec_user_group: p.cosec_user_group,
      is_default: p.is_default,
    });
    setDialogOpen(true);
  }

  function toggleDay(day: number) {
    setForm(prev => ({
      ...prev,
      allowed_days: prev.allowed_days.includes(day)
        ? prev.allowed_days.filter(d => d !== day)
        : [...prev.allowed_days, day],
    }));
  }

  async function handleSave() {
    if (!form.name.trim()) { toast.error("Name is required"); return; }
    if (form.allowed_days.length === 0) { toast.error("Select at least one day"); return; }
    setSaving(true);
    try {
      const payload = {
        ...form,
        description: form.description || null,
        from_time: form.from_time || null,
        until_time: form.until_time || null,
        cosec_user_group: Number(form.cosec_user_group),
      };
      const url    = editing ? `/api/cosec/access-profiles/${editing.id}` : "/api/cosec/access-profiles";
      const method = editing ? "PATCH" : "POST";
      const res    = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data   = await res.json();
      if (res.ok) {
        toast.success(editing ? "Profile updated" : "Profile created");
        setDialogOpen(false);
        await load();
      } else {
        toast.error(data.error ?? "Failed to save");
      }
    } finally { setSaving(false); }
  }

  async function handleDelete(p: AccessProfile) {
    if (!confirm(`Delete "${p.name}"? This cannot be undone.`)) return;
    setDeleting(p.id);
    try {
      const res  = await fetch(`/api/cosec/access-profiles/${p.id}`, { method: "DELETE" });
      const data = await res.json();
      if (res.ok) { toast.success("Profile deleted"); await load(); }
      else toast.error(data.error ?? "Failed to delete");
    } finally { setDeleting(null); }
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Access Profiles</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Define named access policies — allowed days, time windows, and COSEC user-group mapping.
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus size={14} className="mr-1.5" /> New Profile
        </Button>
      </div>

      {/* How it works */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-800 flex gap-3">
        <Info size={16} className="shrink-0 mt-0.5" />
        <div className="space-y-1">
          <p className="font-medium">How time restrictions work</p>
          <p className="text-blue-700">
            Each profile maps to a COSEC <strong>user-group number</strong> (0–999). Configure the corresponding
            time-zone in the COSEC device admin UI once — the device then enforces the schedule automatically
            for all employees assigned to that group.
          </p>
        </div>
      </div>

      {/* Profile list */}
      {loading ? (
        <div className="flex justify-center py-12"><Loader2 size={28} className="animate-spin text-muted-foreground" /></div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {profiles.map(p => (
            <Card key={p.id} className={p.is_default ? "border-primary/40 ring-1 ring-primary/20" : ""}>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <CardTitle className="text-base flex items-center gap-2">
                      <Shield size={15} className="text-primary" />
                      {p.name}
                      {p.is_default && <Badge className="text-xs">Default</Badge>}
                    </CardTitle>
                    {p.description && (
                      <p className="text-xs text-muted-foreground mt-0.5">{p.description}</p>
                    )}
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button size="sm" variant="ghost" onClick={() => openEdit(p)}>
                      <Pencil size={13} />
                    </Button>
                    <Button
                      size="sm" variant="ghost" className="text-red-500 hover:text-red-600"
                      disabled={deleting === p.id}
                      onClick={() => handleDelete(p)}
                    >
                      {deleting === p.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex items-center gap-2">
                  <Calendar size={13} className="text-muted-foreground shrink-0" />
                  <span>{formatDays(p.allowed_days)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Clock size={13} className="text-muted-foreground shrink-0" />
                  <span>
                    {p.from_time || p.until_time
                      ? `${formatTime(p.from_time)} – ${formatTime(p.until_time)}`
                      : "All hours"}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-muted-foreground text-xs">
                  <Shield size={11} />
                  <span>COSEC user-group <strong>{p.cosec_user_group}</strong></span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create / Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Access Profile" : "New Access Profile"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">

            <div className="space-y-1.5">
              <Label>Profile Name *</Label>
              <Input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="e.g. Standard, Management, 24/7" />
            </div>

            <div className="space-y-1.5">
              <Label>Description</Label>
              <Input value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} placeholder="Brief description (optional)" />
            </div>

            <div className="space-y-2">
              <Label>Allowed Days *</Label>
              <div className="flex gap-1.5 flex-wrap">
                {DAYS.map(d => (
                  <button
                    key={d.value}
                    type="button"
                    onClick={() => toggleDay(d.value)}
                    className={`px-3 py-1.5 rounded-md text-sm font-medium border transition-colors ${
                      form.allowed_days.includes(d.value)
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-white text-muted-foreground border-input hover:bg-slate-50"
                    }`}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
              {form.allowed_days.length > 0 && (
                <p className="text-xs text-muted-foreground">{formatDays(form.allowed_days)}</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>From Time <span className="text-muted-foreground text-xs">(blank = any)</span></Label>
                <Input type="time" value={form.from_time} onChange={e => setForm(p => ({ ...p, from_time: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label>Until Time <span className="text-muted-foreground text-xs">(blank = any)</span></Label>
                <Input type="time" value={form.until_time} onChange={e => setForm(p => ({ ...p, until_time: e.target.value }))} />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>COSEC User-Group (0–999)</Label>
              <Input
                type="number" min={0} max={999}
                value={form.cosec_user_group}
                onChange={e => setForm(p => ({ ...p, cosec_user_group: Number(e.target.value) }))}
              />
              <p className="text-xs text-muted-foreground flex items-start gap-1">
                <AlertTriangle size={11} className="mt-0.5 text-amber-500 shrink-0" />
                Configure the matching time-zone for user-group {form.cosec_user_group} in COSEC device admin for time restrictions to take effect.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="is_default"
                checked={form.is_default}
                onChange={e => setForm(p => ({ ...p, is_default: e.target.checked }))}
                className="rounded"
              />
              <Label htmlFor="is_default" className="cursor-pointer">Set as default profile for new access grants</Label>
            </div>

          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 size={13} className="animate-spin mr-1" /> : null}
              {editing ? "Save Changes" : "Create Profile"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
