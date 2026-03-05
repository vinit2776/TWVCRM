"use client";

import { useState, useEffect, useCallback } from "react";
import { Plus, Pencil, Trash2, Loader2, BookMarked, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import { toast } from "sonner";
import type { LineItemData } from "@/components/shared/line-items-editor";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Preset {
  id: string;
  name: string;
  description: string;
  quantity: number;
  unit: string | null;
  unit_price: number;
  category: string | null;
  sort_order: number;
  is_active: boolean;
}

const EMPTY_FORM = {
  name: "",
  description: "",
  quantity: "1",
  unit: "",
  unit_price: "",
  category: "",
  sort_order: "0",
  is_active: true,
};

// ---------------------------------------------------------------------------
// ManagePresetsDialog — inline CRUD for the preset library
// ---------------------------------------------------------------------------

interface ManagePresetsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPresetsChanged: () => void;
}

function ManagePresetsDialog({ open, onOpenChange, onPresetsChanged }: ManagePresetsDialogProps) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loading, setLoading] = useState(false);
  const [addingNew, setAddingNew] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      // Fetch all (active + inactive) for management view
      const res = await fetch("/api/proposal-presets?all=1");
      if (res.ok) {
        const json = await res.json();
        setPresets(json.data ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) fetchAll();
  }, [open, fetchAll]);

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setAddingNew(false);
    setEditingId(null);
  };

  const startEdit = (preset: Preset) => {
    setEditingId(preset.id);
    setAddingNew(false);
    setForm({
      name:       preset.name,
      description: preset.description,
      quantity:   String(preset.quantity),
      unit:       preset.unit ?? "",
      unit_price: String(preset.unit_price),
      category:   preset.category ?? "",
      sort_order: String(preset.sort_order),
      is_active:  preset.is_active,
    });
  };

  const handleSave = async () => {
    if (!form.name.trim()) { toast.error("Name is required"); return; }
    if (!form.description.trim()) { toast.error("Description is required"); return; }
    if (form.unit_price === "" || isNaN(Number(form.unit_price))) {
      toast.error("Unit price is required"); return;
    }

    setSaving(true);
    const body = {
      name:       form.name.trim(),
      description: form.description.trim(),
      quantity:   Number(form.quantity) || 1,
      unit:       form.unit.trim() || null,
      unit_price: Number(form.unit_price),
      category:   form.category.trim() || null,
      sort_order: Number(form.sort_order) || 0,
      is_active:  form.is_active,
    };

    try {
      let res: Response;
      if (editingId) {
        res = await fetch(`/api/proposal-presets/${editingId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } else {
        res = await fetch("/api/proposal-presets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      }

      if (res.ok) {
        toast.success(editingId ? "Preset updated" : "Preset created");
        resetForm();
        await fetchAll();
        onPresetsChanged();
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to save preset");
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete preset "${name}"?`)) return;
    const res = await fetch(`/api/proposal-presets/${id}`, { method: "DELETE" });
    if (res.ok) {
      toast.success("Preset deleted");
      await fetchAll();
      onPresetsChanged();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to delete preset");
    }
  };

  const handleToggleActive = async (preset: Preset) => {
    const res = await fetch(`/api/proposal-presets/${preset.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_active: !preset.is_active }),
    });
    if (res.ok) {
      await fetchAll();
      onPresetsChanged();
    }
  };

  const isFormOpen = addingNew || editingId !== null;

  return (
    <Dialog open={open} onOpenChange={(v) => { resetForm(); onOpenChange(v); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Manage Line Item Presets</DialogTitle>
        </DialogHeader>

        {/* Add / Edit form */}
        {isFormOpen && (
          <div className="border rounded-lg p-4 space-y-3 bg-muted/30">
            <p className="text-sm font-medium">{editingId ? "Edit Preset" : "New Preset"}</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Name *</Label>
                <Input
                  placeholder="e.g. Private Office 4-Seat"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Category</Label>
                <Input
                  placeholder="e.g. Office, Services, Add-ons"
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                />
              </div>
              <div className="col-span-2 space-y-1">
                <Label className="text-xs">Description * (shown in line item)</Label>
                <Input
                  placeholder="e.g. Private Office — 4 Seats, Monthly"
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Qty</Label>
                <Input
                  type="number"
                  min={1}
                  value={form.quantity}
                  onChange={(e) => setForm({ ...form, quantity: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Unit</Label>
                <Input
                  placeholder="months, hrs, seats…"
                  value={form.unit}
                  onChange={(e) => setForm({ ...form, unit: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Unit Price *</Label>
                <Input
                  type="number"
                  min={0}
                  placeholder="0"
                  value={form.unit_price}
                  onChange={(e) => setForm({ ...form, unit_price: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Sort Order</Label>
                <Input
                  type="number"
                  min={0}
                  value={form.sort_order}
                  onChange={(e) => setForm({ ...form, sort_order: e.target.value })}
                />
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <Button size="sm" onClick={handleSave} disabled={saving}>
                {saving && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
                {editingId ? "Save Changes" : "Create Preset"}
              </Button>
              <Button size="sm" variant="ghost" onClick={resetForm}>Cancel</Button>
            </div>
          </div>
        )}

        {/* Preset list */}
        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : presets.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            No presets yet. Create one above to get started.
          </p>
        ) : (
          <div className="divide-y rounded-lg border">
            {presets.map((preset) => (
              <div key={preset.id} className="flex items-center gap-3 px-4 py-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium truncate">{preset.name}</span>
                    {preset.category && (
                      <Badge variant="secondary" className="text-xs">{preset.category}</Badge>
                    )}
                    {!preset.is_active && (
                      <Badge variant="outline" className="text-xs text-muted-foreground">Inactive</Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground truncate mt-0.5">{preset.description}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {preset.quantity} {preset.unit || "unit"} · {formatCurrency(preset.unit_price)}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    title={preset.is_active ? "Deactivate" : "Activate"}
                    onClick={() => handleToggleActive(preset)}
                  >
                    <span className={`text-xs font-bold ${preset.is_active ? "text-green-600" : "text-muted-foreground"}`}>
                      {preset.is_active ? "ON" : "OFF"}
                    </span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => startEdit(preset)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    onClick={() => handleDelete(preset.id, preset.name)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => { resetForm(); setAddingNew(true); }}
            disabled={isFormOpen}
          >
            <Plus className="mr-2 h-3.5 w-3.5" />
            Add Preset
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// PresetPickerDialog — search & insert presets into line items
// ---------------------------------------------------------------------------

interface PresetPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAddItem: (item: LineItemData) => void;
}

export function PresetPickerDialog({ open, onOpenChange, onAddItem }: PresetPickerDialogProps) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [manageOpen, setManageOpen] = useState(false);

  const fetchPresets = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/proposal-presets");
      if (res.ok) {
        const json = await res.json();
        setPresets(json.data ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setSearch("");
      fetchPresets();
    }
  }, [open, fetchPresets]);

  // Filter by search term
  const filtered = presets.filter((p) => {
    const q = search.toLowerCase();
    return (
      p.name.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q) ||
      (p.category?.toLowerCase().includes(q) ?? false)
    );
  });

  // Group by category
  const grouped = filtered.reduce<Record<string, Preset[]>>((acc, preset) => {
    const key = preset.category ?? "__general__";
    if (!acc[key]) acc[key] = [];
    acc[key].push(preset);
    return acc;
  }, {});

  const categoryOrder = Object.keys(grouped).sort((a, b) => {
    if (a === "__general__") return 1;
    if (b === "__general__") return -1;
    return a.localeCompare(b);
  });

  const handleAdd = (preset: Preset) => {
    onAddItem({
      description: preset.description,
      quantity:    preset.quantity,
      unit:        preset.unit ?? "",
      unit_price:  preset.unit_price,
      total:       preset.quantity * preset.unit_price,
    });
    toast.success(`"${preset.name}" added`);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <BookMarked className="h-4 w-4" />
              Add from Presets
            </DialogTitle>
          </DialogHeader>

          {/* Search */}
          <Input
            placeholder="Search presets…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="shrink-0"
          />

          {/* List */}
          <div className="flex-1 overflow-y-auto space-y-4 min-h-0">
            {loading ? (
              <div className="flex justify-center py-10">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : filtered.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-10">
                {presets.length === 0
                  ? "No presets yet. Click Manage Presets to create one."
                  : "No presets match your search."}
              </p>
            ) : (
              categoryOrder.map((cat) => (
                <div key={cat}>
                  {cat !== "__general__" && (
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                      {cat}
                    </p>
                  )}
                  <div className="divide-y rounded-lg border">
                    {grouped[cat].map((preset) => (
                      <div key={preset.id} className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/50">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{preset.name}</p>
                          <p className="text-xs text-muted-foreground truncate">{preset.description}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            Qty {preset.quantity}{preset.unit ? ` ${preset.unit}` : ""} · {formatCurrency(preset.unit_price)}
                            <span className="ml-2 font-medium text-foreground">
                              = {formatCurrency(preset.quantity * preset.unit_price)}
                            </span>
                          </p>
                        </div>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 shrink-0 hover:bg-primary hover:text-primary-foreground"
                          onClick={() => handleAdd(preset)}
                        >
                          <Plus className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between border-t pt-3 shrink-0">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => setManageOpen(true)}
            >
              <Settings2 className="mr-2 h-3.5 w-3.5" />
              Manage Presets
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <ManagePresetsDialog
        open={manageOpen}
        onOpenChange={setManageOpen}
        onPresetsChanged={fetchPresets}
      />
    </>
  );
}
