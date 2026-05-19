"use client";

import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Package, Upload, Download, Pencil, Trash2, Plus, Check, X, AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";
import Papa from "papaparse";
import type { LeaseAsset } from "@/types";
import { ASSET_CATEGORY_LABELS, ASSET_CONDITION_LABELS } from "@/lib/constants";

// ── helpers ──────────────────────────────────────────────────────────────────

const CATEGORIES = Object.keys(ASSET_CATEGORY_LABELS) as (keyof typeof ASSET_CATEGORY_LABELS)[];
const CONDITIONS = Object.keys(ASSET_CONDITION_LABELS) as (keyof typeof ASSET_CONDITION_LABELS)[];

// Map freetext category → enum value (used when parsing imports)
const CATEGORY_ALIAS: Record<string, string> = {
  civil: "civil", structure: "civil", structural: "civil",
  electrical: "electrical", electric: "electrical", power: "electrical",
  furniture: "furniture", furnishing: "furniture",
  equipment: "equipment", appliance: "equipment", machine: "equipment",
  it: "it", tech: "it", technology: "it", computer: "it", network: "it",
  fitting: "fitting", fixture: "fitting", plumbing: "fitting",
  other: "other",
};

function normaliseCategory(raw: string): string | null {
  const key = raw.trim().toLowerCase();
  return CATEGORY_ALIAS[key] ?? null;
}

function normaliseCondition(raw: string): string | null {
  const key = raw.trim().toLowerCase();
  if (CONDITIONS.includes(key as never)) return key;
  if (key === "excellent") return "excellent";
  if (key.startsWith("good")) return "good";
  if (key.startsWith("fair") || key === "average") return "fair";
  if (key.startsWith("poor") || key === "bad") return "poor";
  return null;
}

// ── template download ─────────────────────────────────────────────────────────

function downloadTemplate() {
  const rows = [
    ["item_name", "category", "quantity", "condition", "notes"],
    ["Split AC 1.5 Ton", "electrical", "3", "good", "Carrier brand"],
    ["Office Chair", "furniture", "50", "fair", ""],
    ["CCTV Camera", "it", "8", "good", "Hikvision with DVR"],
    ["Conference Table", "furniture", "2", "excellent", ""],
  ];
  const csv = rows.map((r) => r.map((c) => `"${c}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "asset_template.csv";
  a.click();
  URL.revokeObjectURL(url);
}

// ── types ─────────────────────────────────────────────────────────────────────

type ImportRow = {
  asset_name: string;
  asset_category: string | null;
  quantity: number;
  condition_at_takeover: string | null;
  notes: string;
  _error?: string;
};

type EditState = {
  asset_name: string;
  asset_category: string;
  quantity: string;
  condition_at_takeover: string;
  notes: string;
};

// ── component ────────────────────────────────────────────────────────────────

export function AssetManager({
  leaseId,
  assets,
  canEdit,
  onRefresh,
}: {
  leaseId: string;
  assets: LeaseAsset[];
  canEdit: boolean;
  onRefresh: () => void;
}) {
  // import dialog
  const [importOpen, setImportOpen] = useState(false);
  const [importRows, setImportRows] = useState<ImportRow[]>([]);
  const [importMode, setImportMode] = useState<"append" | "replace">("append");
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // inline editing
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editState, setEditState] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // new row
  const [addingRow, setAddingRow] = useState(false);
  const [newRow, setNewRow] = useState<EditState>({
    asset_name: "", asset_category: "", quantity: "1",
    condition_at_takeover: "", notes: "",
  });
  const [addingSaving, setAddingSaving] = useState(false);

  // ── file parsing ─────────────────────────────────────────────────────────

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const ext = file.name.split(".").pop()?.toLowerCase();

    if (ext === "xlsx" || ext === "xls") {
      // Use SheetJS dynamically to avoid SSR issues
      const XLSX = await import("xlsx");
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_csv(ws);
      parseCSVText(raw);
    } else {
      const text = await file.text();
      parseCSVText(text);
    }

    // Reset input so same file can be re-selected
    if (fileRef.current) fileRef.current.value = "";
  }

  function parseCSVText(text: string) {
    const result = Papa.parse<string[]>(text.trim(), { skipEmptyLines: true });
    if (result.errors.length && !result.data.length) {
      toast.error("Could not parse file");
      return;
    }

    const rows = result.data as string[][];
    if (!rows.length) { toast.error("File appears empty"); return; }

    // Detect header row
    const header = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
    const nameIdx = header.findIndex((h) => ["item_name", "name", "asset_name", "item", "description"].includes(h));
    const catIdx  = header.findIndex((h) => ["category", "cat", "type"].includes(h));
    const qtyIdx  = header.findIndex((h) => ["quantity", "qty", "count"].includes(h));
    const condIdx = header.findIndex((h) => ["condition", "cond", "state"].includes(h));
    const notesIdx = header.findIndex((h) => ["notes", "note", "remarks", "comment"].includes(h));

    const dataRows = nameIdx >= 0 ? rows.slice(1) : rows; // skip header if found
    const nameCol = nameIdx >= 0 ? nameIdx : 0;

    const parsed: ImportRow[] = dataRows
      .filter((r) => r[nameCol]?.trim())
      .map((r) => {
        const qty = parseInt(qtyIdx >= 0 ? r[qtyIdx] : "", 10);
        const row: ImportRow = {
          asset_name: r[nameCol]?.trim() ?? "",
          asset_category: catIdx >= 0 ? normaliseCategory(r[catIdx] ?? "") : null,
          quantity: isNaN(qty) || qty < 1 ? 1 : qty,
          condition_at_takeover: condIdx >= 0 ? normaliseCondition(r[condIdx] ?? "") : null,
          notes: (notesIdx >= 0 ? r[notesIdx] : "")?.trim() ?? "",
        };
        if (!row.asset_name) row._error = "Missing item name";
        return row;
      });

    if (!parsed.length) { toast.error("No valid rows found"); return; }
    setImportRows(parsed);
    setImportOpen(true);
  }

  async function handleImport() {
    const valid = importRows.filter((r) => !r._error);
    if (!valid.length) { toast.error("No valid rows to import"); return; }
    setImporting(true);
    const r = await fetch(`/api/rent-management/leases/${leaseId}/assets/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assets: valid, mode: importMode }),
    });
    setImporting(false);
    if (r.ok) {
      const json = await r.json();
      toast.success(`${json.count} asset${json.count !== 1 ? "s" : ""} imported`);
      setImportOpen(false);
      setImportRows([]);
      onRefresh();
    } else {
      const err = await r.json();
      toast.error(err.error || "Import failed");
    }
  }

  // ── inline edit ──────────────────────────────────────────────────────────

  function startEdit(a: LeaseAsset) {
    setEditingId(a.id);
    setEditState({
      asset_name: a.asset_name,
      asset_category: a.asset_category ?? "",
      quantity: String(a.quantity ?? 1),
      condition_at_takeover: a.condition_at_takeover ?? "",
      notes: a.notes ?? "",
    });
  }

  async function saveEdit(assetId: string) {
    if (!editState) return;
    setSaving(true);
    const body = {
      asset_name: editState.asset_name,
      asset_category: editState.asset_category || null,
      quantity: parseInt(editState.quantity) || 1,
      condition_at_takeover: editState.condition_at_takeover || null,
      notes: editState.notes || null,
    };
    const r = await fetch(`/api/rent-management/leases/${leaseId}/assets/${assetId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setSaving(false);
    if (r.ok) {
      toast.success("Asset updated");
      setEditingId(null);
      setEditState(null);
      onRefresh();
    } else {
      const err = await r.json();
      toast.error(err.error || "Save failed");
    }
  }

  async function deleteAsset(assetId: string) {
    setDeletingId(assetId);
    const r = await fetch(`/api/rent-management/leases/${leaseId}/assets/${assetId}`, {
      method: "DELETE",
    });
    setDeletingId(null);
    if (r.ok) {
      toast.success("Asset removed");
      onRefresh();
    } else {
      toast.error("Failed to remove asset");
    }
  }

  // ── add new row ──────────────────────────────────────────────────────────

  async function saveNewRow() {
    if (!newRow.asset_name.trim()) { toast.error("Item name is required"); return; }
    setAddingSaving(true);
    const r = await fetch(`/api/rent-management/leases/${leaseId}/assets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        asset_name: newRow.asset_name.trim(),
        asset_category: newRow.asset_category || null,
        quantity: parseInt(newRow.quantity) || 1,
        condition_at_takeover: newRow.condition_at_takeover || null,
        notes: newRow.notes || null,
      }),
    });
    setAddingSaving(false);
    if (r.ok) {
      toast.success("Asset added");
      setAddingRow(false);
      setNewRow({ asset_name: "", asset_category: "", quantity: "1", condition_at_takeover: "", notes: "" });
      onRefresh();
    } else {
      const err = await r.json();
      toast.error(err.error || "Failed to add asset");
    }
  }

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Package className="h-4 w-4" />Asset Registry
            {assets.length > 0 && (
              <Badge variant="secondary" className="text-xs font-normal">{assets.length} items</Badge>
            )}
          </CardTitle>
          {canEdit && (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={downloadTemplate}>
                <Download className="h-3.5 w-3.5 mr-1" />Template
              </Button>
              <label>
                <Button size="sm" variant="outline" asChild>
                  <span className="cursor-pointer">
                    <Upload className="h-3.5 w-3.5 mr-1" />Import
                  </span>
                </Button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv,.xlsx,.xls"
                  className="hidden"
                  onChange={handleFileChange}
                />
              </label>
              <Button size="sm" variant="outline" onClick={() => setAddingRow(true)} disabled={addingRow}>
                <Plus className="h-3.5 w-3.5 mr-1" />Add Row
              </Button>
            </div>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {assets.length === 0 && !addingRow ? (
            <div className="py-10 text-center text-sm text-muted-foreground space-y-2">
              <p>No assets recorded yet.</p>
              {canEdit && (
                <p className="text-xs">Download the template, fill it in Excel, and import — or add rows one by one.</p>
              )}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="text-left px-4 py-2.5 font-medium">Item</th>
                  <th className="text-left px-3 py-2.5 font-medium">Category</th>
                  <th className="text-right px-3 py-2.5 font-medium w-16">Qty</th>
                  <th className="text-left px-3 py-2.5 font-medium">Condition</th>
                  <th className="text-left px-3 py-2.5 font-medium hidden sm:table-cell">Notes</th>
                  {canEdit && <th className="w-20 px-3 py-2.5" />}
                </tr>
              </thead>
              <tbody>
                {assets.map((a) =>
                  editingId === a.id && editState ? (
                    // ── edit row ──
                    <tr key={a.id} className="border-b bg-muted/10">
                      <td className="px-2 py-1.5">
                        <Input
                          value={editState.asset_name}
                          onChange={(e) => setEditState((s) => s && ({ ...s, asset_name: e.target.value }))}
                          className="h-8 text-sm"
                          autoFocus
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <Select
                          value={editState.asset_category}
                          onValueChange={(v) => setEditState((s) => s && ({ ...s, asset_category: v }))}
                        >
                          <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="—" /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="">—</SelectItem>
                            {CATEGORIES.map((c) => <SelectItem key={c} value={c}>{ASSET_CATEGORY_LABELS[c]}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          type="number"
                          value={editState.quantity}
                          onChange={(e) => setEditState((s) => s && ({ ...s, quantity: e.target.value }))}
                          className="h-8 text-sm w-16 text-right"
                          min="1"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <Select
                          value={editState.condition_at_takeover}
                          onValueChange={(v) => setEditState((s) => s && ({ ...s, condition_at_takeover: v }))}
                        >
                          <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="—" /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="">—</SelectItem>
                            {CONDITIONS.map((c) => <SelectItem key={c} value={c}>{ASSET_CONDITION_LABELS[c]}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </td>
                      <td className="px-2 py-1.5 hidden sm:table-cell">
                        <Input
                          value={editState.notes}
                          onChange={(e) => setEditState((s) => s && ({ ...s, notes: e.target.value }))}
                          className="h-8 text-sm"
                          placeholder="Optional notes"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="flex gap-1 justify-end">
                          <Button size="sm" variant="ghost" onClick={() => saveEdit(a.id)} disabled={saving} className="h-7 w-7 p-0">
                            <Check className="h-3.5 w-3.5 text-green-600" />
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => { setEditingId(null); setEditState(null); }} className="h-7 w-7 p-0">
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    // ── read row ──
                    <tr key={a.id} className="border-b hover:bg-muted/20 group">
                      <td className="px-4 py-2.5 font-medium">{a.asset_name}</td>
                      <td className="px-3 py-2.5 text-muted-foreground text-xs">
                        {a.asset_category ? (ASSET_CATEGORY_LABELS[a.asset_category] ?? a.asset_category) : "—"}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{a.quantity}</td>
                      <td className="px-3 py-2.5 text-xs">
                        {a.condition_at_takeover ? (
                          <span className={conditionColor(a.condition_at_takeover)}>
                            {ASSET_CONDITION_LABELS[a.condition_at_takeover] ?? a.condition_at_takeover}
                          </span>
                        ) : "—"}
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground text-xs hidden sm:table-cell max-w-xs truncate">
                        {a.notes || "—"}
                      </td>
                      {canEdit && (
                        <td className="px-2 py-2.5">
                          <div className="flex gap-1 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => startEdit(a)}>
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                              onClick={() => deleteAsset(a.id)}
                              disabled={deletingId === a.id}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </td>
                      )}
                    </tr>
                  )
                )}

                {/* ── add new row ── */}
                {addingRow && (
                  <tr className="border-b bg-muted/10">
                    <td className="px-2 py-1.5">
                      <Input
                        value={newRow.asset_name}
                        onChange={(e) => setNewRow((r) => ({ ...r, asset_name: e.target.value }))}
                        className="h-8 text-sm"
                        placeholder="Item name *"
                        autoFocus
                        onKeyDown={(e) => e.key === "Enter" && saveNewRow()}
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <Select value={newRow.asset_category} onValueChange={(v) => setNewRow((r) => ({ ...r, asset_category: v }))}>
                        <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="—" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="">—</SelectItem>
                          {CATEGORIES.map((c) => <SelectItem key={c} value={c}>{ASSET_CATEGORY_LABELS[c]}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="px-2 py-1.5">
                      <Input
                        type="number"
                        value={newRow.quantity}
                        onChange={(e) => setNewRow((r) => ({ ...r, quantity: e.target.value }))}
                        className="h-8 text-sm w-16 text-right"
                        min="1"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <Select value={newRow.condition_at_takeover} onValueChange={(v) => setNewRow((r) => ({ ...r, condition_at_takeover: v }))}>
                        <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="—" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="">—</SelectItem>
                          {CONDITIONS.map((c) => <SelectItem key={c} value={c}>{ASSET_CONDITION_LABELS[c]}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="px-2 py-1.5 hidden sm:table-cell">
                      <Input
                        value={newRow.notes}
                        onChange={(e) => setNewRow((r) => ({ ...r, notes: e.target.value }))}
                        className="h-8 text-sm"
                        placeholder="Notes"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <div className="flex gap-1 justify-end">
                        <Button size="sm" variant="ghost" onClick={saveNewRow} disabled={addingSaving} className="h-7 w-7 p-0">
                          <Check className="h-3.5 w-3.5 text-green-600" />
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => { setAddingRow(false); setNewRow({ asset_name: "", asset_category: "", quantity: "1", condition_at_takeover: "", notes: "" }); }} className="h-7 w-7 p-0">
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* ── Import Preview Dialog ── */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Import Assets — Preview</DialogTitle>
          </DialogHeader>

          <div className="flex items-center gap-4 py-2 border-b">
            <span className="text-sm font-medium">
              {importRows.filter((r) => !r._error).length} valid rows
              {importRows.some((r) => r._error) && (
                <span className="ml-2 text-destructive text-xs">
                  · {importRows.filter((r) => r._error).length} skipped (missing name)
                </span>
              )}
            </span>
            <div className="ml-auto flex items-center gap-3">
              <span className="text-sm text-muted-foreground">Mode:</span>
              <Select value={importMode} onValueChange={(v) => setImportMode(v as "append" | "replace")}>
                <SelectTrigger className="h-8 w-40 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="append">Add to existing</SelectItem>
                  <SelectItem value="replace">Replace all existing</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {importMode === "replace" && assets.length > 0 && (
            <div className="flex items-center gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              This will delete all {assets.length} existing asset{assets.length !== 1 ? "s" : ""} and replace with the imported rows.
            </div>
          )}

          <div className="overflow-auto flex-1 border rounded">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="text-left px-3 py-2 font-medium">Item Name</th>
                  <th className="text-left px-3 py-2 font-medium">Category</th>
                  <th className="text-right px-3 py-2 font-medium w-14">Qty</th>
                  <th className="text-left px-3 py-2 font-medium">Condition</th>
                  <th className="text-left px-3 py-2 font-medium">Notes</th>
                </tr>
              </thead>
              <tbody>
                {importRows.map((row, i) => (
                  <tr key={i} className={`border-b ${row._error ? "bg-red-50 text-muted-foreground line-through" : ""}`}>
                    <td className="px-3 py-1.5">{row.asset_name || <span className="text-destructive italic">missing</span>}</td>
                    <td className="px-3 py-1.5 text-muted-foreground">
                      {row.asset_category ? (ASSET_CATEGORY_LABELS[row.asset_category] ?? row.asset_category) : <span className="italic">—</span>}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{row.quantity}</td>
                    <td className="px-3 py-1.5 text-muted-foreground">
                      {row.condition_at_takeover ? (ASSET_CONDITION_LABELS[row.condition_at_takeover] ?? row.condition_at_takeover) : <span className="italic">—</span>}
                    </td>
                    <td className="px-3 py-1.5 text-muted-foreground max-w-xs truncate">{row.notes || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => { setImportOpen(false); setImportRows([]); }}>Cancel</Button>
            <Button onClick={handleImport} disabled={importing || !importRows.some((r) => !r._error)}>
              {importing ? "Importing…" : `Import ${importRows.filter((r) => !r._error).length} rows`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function conditionColor(c: string) {
  if (c === "excellent") return "text-green-700";
  if (c === "good") return "text-green-600";
  if (c === "fair") return "text-yellow-700";
  if (c === "poor") return "text-red-600";
  return "";
}
