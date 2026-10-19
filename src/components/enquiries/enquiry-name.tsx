"use client";

import { useState } from "react";
import { Pencil } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";

interface Props {
  enquiryId: string;
  name: string;
  /** The lead is still called "WhatsApp contact": draw attention to naming it. */
  placeholder?: boolean;
  /** A name the customer gave in their message, offered for one tap. */
  suggestedName?: string | null;
  /** Called after a successful rename so the host view refetches. */
  onChanged: () => void;
}

/** One-click naming: a small "Add name" prompt (or a pencil once named) next to the name, with a
 *  suggestion taken from the customer's message. Renames the lead itself. */
export function EnquiryNameControl({ enquiryId, name, placeholder = false, suggestedName, onChanged }: Props) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);

  async function save(next: string) {
    const trimmed = next.trim();
    if (!trimmed) { toast.error("Enter a name first"); return; }
    setSaving(true);
    const res = await fetch(`/api/enquiries/${enquiryId}/name`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: trimmed }),
    });
    setSaving(false);
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      toast.error(json?.error ?? "Could not save the name");
      return;
    }
    toast.success("Name saved");
    setEditing(false);
    onChanged();
  }

  if (editing) {
    return (
      <span className="inline-flex items-center gap-1">
        <Input
          autoFocus
          value={value}
          maxLength={80}
          disabled={saving}
          placeholder="Customer name"
          className="h-7 w-40 text-xs"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save(value);
            if (e.key === "Escape") setEditing(false);
          }}
        />
        <button onClick={() => save(value)} disabled={saving} className="rounded-md border px-1.5 py-0.5 text-[11px] font-medium hover:bg-muted">
          Save
        </button>
        <button onClick={() => setEditing(false)} className="text-[11px] text-muted-foreground hover:underline">
          Cancel
        </button>
      </span>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {placeholder ? (
        <button
          onClick={() => { setValue(suggestedName ?? ""); setEditing(true); }}
          className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 hover:bg-amber-200"
        >
          Add name
        </button>
      ) : (
        <button onClick={() => { setValue(name); setEditing(true); }} title="Edit name" aria-label="Edit name" className="text-muted-foreground hover:text-foreground">
          <Pencil className="h-3 w-3" />
        </button>
      )}
      {placeholder && suggestedName && (
        <button
          onClick={() => save(suggestedName)}
          title="Name taken from the customer's message"
          className="rounded-full border border-slate-300 px-1.5 py-0.5 text-[10px] font-medium text-slate-700 hover:bg-slate-100"
        >
          Use “{suggestedName}”
        </button>
      )}
    </span>
  );
}
