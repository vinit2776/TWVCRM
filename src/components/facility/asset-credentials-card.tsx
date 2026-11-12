"use client";

import { useEffect, useState } from "react";
import { KeyRound, Eye, Copy, Check, Loader2, Pencil, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { FACILITY_ROLES } from "@/lib/facility";
import type { FacilityAssetCredentials } from "@/types";

interface Props {
  assetId: string;
  userRole: string;
}

const CAN_MANAGE: readonly string[] = FACILITY_ROLES.credentials;

export function AssetCredentialsCard({ assetId, userRole }: Props) {
  const [creds, setCreds] = useState<FacilityAssetCredentials | null | undefined>(undefined);
  const [revealedPassword, setRevealedPassword] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const canManage = CAN_MANAGE.includes(userRole);

  const load = () => {
    fetch(`/api/facility/assets/${assetId}/credentials`)
      .then((r) => r.json())
      .then((j) => setCreds(j.data ?? null))
      .catch(() => setCreds(null));
  };

  useEffect(() => {
    load();
    setRevealedPassword(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId]);

  const handleReveal = async () => {
    setRevealing(true);
    try {
      const res = await fetch(`/api/facility/assets/${assetId}/credentials/reveal`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to reveal password");
      setRevealedPassword(json.password);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to reveal password");
    } finally {
      setRevealing(false);
    }
  };

  const handleCopy = () => {
    if (!revealedPassword) return;
    navigator.clipboard.writeText(revealedPassword);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Still loading, or nothing on file and this viewer can't add any —
  // nothing useful to show.
  if (creds === undefined) return null;
  if (creds === null && !canManage) return null;

  return (
    <section className="rounded-lg border bg-card p-4 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
          <KeyRound className="h-3.5 w-3.5" /> Login Credentials
        </div>
        {canManage && (
          <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
            <Pencil className="h-3.5 w-3.5 mr-1" /> {creds ? "Edit" : "Add"}
          </Button>
        )}
      </div>

      {creds === null ? (
        <p className="text-sm text-muted-foreground italic py-1">No login credentials on file.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
          <div>
            <div className="text-[11px] text-muted-foreground">Admin URL</div>
            {creds.admin_url ? (
              <a
                href={creds.admin_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline flex items-center gap-1 break-all"
              >
                {creds.admin_url} <ExternalLink className="h-3 w-3 shrink-0" />
              </a>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </div>
          <div>
            <div className="text-[11px] text-muted-foreground">Username</div>
            <span className={creds.username ? "font-mono" : "text-muted-foreground"}>{creds.username || "—"}</span>
          </div>
          <div>
            <div className="text-[11px] text-muted-foreground">Password</div>
            {revealedPassword ? (
              <div className="flex items-center gap-1.5">
                <span className="font-mono">{revealedPassword}</span>
                <button type="button" onClick={handleCopy} title="Copy password" className="text-muted-foreground hover:text-foreground">
                  {copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
              </div>
            ) : canManage ? (
              <Button size="sm" variant="ghost" className="h-6 px-2 -ml-2" onClick={handleReveal} disabled={revealing}>
                {revealing ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Eye className="h-3.5 w-3.5 mr-1" />}
                Reveal
              </Button>
            ) : (
              <span className="text-muted-foreground">•••••••• (restricted)</span>
            )}
          </div>
        </div>
      )}

      {editOpen && (
        <CredentialsEditDialog
          assetId={assetId}
          initial={creds}
          onOpenChange={setEditOpen}
          onSaved={() => { load(); setRevealedPassword(null); }}
        />
      )}
    </section>
  );
}

function CredentialsEditDialog({
  assetId, initial, onOpenChange, onSaved,
}: {
  assetId: string;
  initial: FacilityAssetCredentials | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [adminUrl, setAdminUrl] = useState(initial?.admin_url ?? "");
  const [username, setUsername] = useState(initial?.username ?? "");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!initial && !password.trim()) {
      toast.error("Password is required when adding credentials for the first time");
      return;
    }
    setSaving(true);
    try {
      const body: Record<string, string> = { admin_url: adminUrl.trim(), username: username.trim() };
      if (password.trim()) body.password = password.trim();
      const res = await fetch(`/api/facility/assets/${assetId}/credentials`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to save credentials");
      toast.success("Login credentials saved");
      onSaved();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save credentials");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{initial ? "Edit" : "Add"} login credentials</DialogTitle>
          <DialogDescription>
            Used to log into this device&apos;s own admin panel (router, modem, printer, etc.). The password is encrypted at rest and only visible via an audited &ldquo;Reveal&rdquo; action.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="cred-url">Admin URL</Label>
            <Input id="cred-url" placeholder="https://192.168.1.1:8080" value={adminUrl} onChange={(e) => setAdminUrl(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="cred-user">Username</Label>
            <Input id="cred-user" value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="cred-pass">Password {initial && <span className="text-muted-foreground font-normal">(leave blank to keep current)</span>}</Label>
            <Input id="cred-pass" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
