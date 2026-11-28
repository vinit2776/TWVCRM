"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { NUMBER_LABELS, NUMBER_LABEL_TEXT, type NumberLabel } from "@/lib/whatsapp-gate";

type Held = {
  id: string;
  mobile: string;
  profile_name: string | null;
  messages: { at: string; text: string }[];
  first_at: string;
  last_at: string;
  payment_chatter?: boolean;
};
type Labelled = { last10: string; label: NumberLabel; name: string | null };

function ago(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

/** Unknown numbers the rules could not judge. Held here (no lead yet) until someone decides. */
export function PossibleLeadsTray({ onChanged }: { onChanged?: () => void }) {
  const [held, setHeld] = useState<Held[]>([]);
  const [labels, setLabels] = useState<Labelled[]>([]);
  const [showLabels, setShowLabels] = useState(false);
  const [labelling, setLabelling] = useState<string | null>(null);
  const [label, setLabel] = useState<NumberLabel>("staff");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [h, l] = await Promise.all([fetch("/api/whatsapp/possible-leads"), fetch("/api/whatsapp/number-labels")]);
    if (h.ok) {
      // Accounts talk sinks to the bottom; nothing is hidden.
      const rows = ((await h.json()).data ?? []) as Held[];
      setHeld([...rows.filter((r) => !r.payment_chatter), ...rows.filter((r) => r.payment_chatter)]);
    }
    if (l.ok) setLabels(((await l.json()).data ?? []) as Labelled[]);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(id: string, body: Record<string, unknown>, done: string) {
    setBusy(id);
    const res = await fetch(`/api/whatsapp/possible-leads/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(null);
    if (!res.ok) {
      toast.error((await res.json().catch(() => null))?.error ?? "Couldn't save that. Try again.");
      void load();
      return;
    }
    toast.success(done);
    setLabelling(null);
    setName("");
    await load();
    onChanged?.();
  }

  async function forget(last10: string) {
    const res = await fetch(`/api/whatsapp/number-labels?last10=${last10}`, { method: "DELETE" });
    if (!res.ok) return toast.error("Couldn't remove that label. Try again.");
    toast.success("Label removed");
    void load();
  }

  if (held.length === 0 && labels.length === 0) return null;

  return (
    <Card className="p-3 space-y-3 border-amber-200">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Possible leads {held.length > 0 && <span className="ml-1 rounded bg-amber-100 px-1.5 text-xs text-amber-800">{held.filter((h) => !h.payment_chatter).length}</span>}</p>
          <p className="text-xs text-muted-foreground">Unknown numbers we couldn&apos;t judge. Nothing here is lost; no lead is created until you say so.</p>
        </div>
        {labels.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => setShowLabels((v) => !v)}>
            Labelled numbers ({labels.length})
          </Button>
        )}
      </div>

      {held.map((h) => (
        <div key={h.id} className="rounded-md border p-3 space-y-2">
          <div className="flex justify-between text-sm">
            <span className="font-medium">{h.profile_name ?? h.mobile}</span>
            <span className="text-xs text-muted-foreground">{ago(h.last_at)}</span>
          </div>
          {h.payment_chatter && (
            <p className="text-xs text-amber-700">
              Reads like payment talk (UTR, transfers), so probably a customer or vendor. Use <strong>Not a lead</strong> or <strong>Label number</strong> to stop these appearing.
            </p>
          )}
          <div className="space-y-0.5 text-sm">
            {h.messages.slice(-3).map((m, i) => (
              <p key={i} className="text-muted-foreground">&ldquo;{m.text}&rdquo;</p>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant={h.payment_chatter ? "outline" : "default"}
              disabled={busy === h.id}
              onClick={() => {
                if (h.payment_chatter && !window.confirm("These messages look like payment talk, not an enquiry. Create an enquiry anyway?")) return;
                void decide(h.id, { action: "lead" }, "Enquiry created");
              }}
            >
              It&apos;s a lead
            </Button>
            <Button size="sm" variant={h.payment_chatter ? "default" : "outline"} disabled={busy === h.id} onClick={() => decide(h.id, { action: "not_lead" }, "Marked as not a lead")}>
              Not a lead
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setLabelling(labelling === h.id ? null : h.id)}>
              Name this person
            </Button>
          </div>
          {labelling === h.id && (
            <div className="flex flex-wrap items-end gap-2 rounded-md bg-muted/50 p-2">
              <Select value={label} onValueChange={(v) => setLabel(v as NumberLabel)}>
                <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {NUMBER_LABELS.map((l) => <SelectItem key={l} value={l}>{NUMBER_LABEL_TEXT[l]}</SelectItem>)}
                </SelectContent>
              </Select>
              <Input className="w-56" placeholder="Ravi (housekeeping)" value={name} onChange={(e) => setName(e.target.value)} />
              <Button size="sm" disabled={busy === h.id} onClick={() => decide(h.id, { action: "label", label, name: name || undefined }, "Number labelled")}>
                Save label
              </Button>
              <p className="w-full text-xs text-muted-foreground">Later messages from this number skip the tray. You can remove the label from Labelled numbers.</p>
            </div>
          )}
        </div>
      ))}

      {showLabels && (
        <div className="space-y-1 text-sm">
          {labels.map((l) => (
            <div key={l.last10} className="flex items-center justify-between rounded border px-2 py-1">
              <span>
                {l.name ? `${l.name} · ` : ""}…{l.last10.slice(-4)} · {NUMBER_LABEL_TEXT[l.label]}
              </span>
              <Button variant="ghost" size="sm" onClick={() => forget(l.last10)}>Remove</Button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
