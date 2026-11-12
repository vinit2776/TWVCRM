"use client";

/**
 * Admin → Tally Sync → Publish Bridge Update card.
 *
 * Wraps the existing /api/tally/update-package endpoint with a minimal UI:
 *   - File picker (accepts .zip)
 *   - Version input (semver)
 *   - Publish button (POST multipart)
 *   - Status card showing the currently-published target version + when the
 *     bridge last picked it up (read from app_settings via /api/settings)
 *
 * The endpoint validates that the zip contains a dist/ folder, stores it
 * in B2, computes SHA-256, and records the target_version + sha256 in
 * app_settings. The bridge picks it up on next heartbeat (~60s) and
 * self-updates between poll cycles.
 *
 * Roles: admin only (the endpoint enforces this; UI mirrors).
 */

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Upload, AlertCircle, CheckCircle2, RefreshCw, Trash2, Loader2, PackageOpen } from "lucide-react";
import { toast } from "sonner";
import { preventEnterSubmit } from "@/lib/utils";

interface PublishedState {
  target_version: string | null;
  sha256: string | null;
  published_at: string | null;
}

async function fetchPublishedState(): Promise<PublishedState> {
  // /api/settings returns { data: [{ key, value, ... }, ...] } for the
  // admin user. We pull the three bridge-update keys out of that.
  const res = await fetch("/api/settings", { cache: "no-store" });
  if (!res.ok) return { target_version: null, sha256: null, published_at: null };
  const { data } = (await res.json()) as { data: Array<{ key: string; value: string }> };
  const map: Record<string, string> = {};
  for (const row of data ?? []) map[row.key] = row.value;
  return {
    target_version: map.tally_bridge_target_version ?? null,
    sha256: map.tally_bridge_update_sha256 ?? null,
    published_at: map.tally_bridge_update_published_at ?? null,
  };
}

export function PublishBridgeCard() {
  const [file, setFile] = useState<File | null>(null);
  const [version, setVersion] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [unpublishing, setUnpublishing] = useState(false);
  const [state, setState] = useState<PublishedState>({ target_version: null, sha256: null, published_at: null });
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await fetchPublishedState();
      setState(s);
    } catch (e) {
      // non-fatal; surface only on action errors
      console.warn("publish-bridge: state fetch failed", e);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function handlePublish(e: React.FormEvent) {
    e.preventDefault();
    if (!file || !version.trim()) return;
    if (!/^\d+\.\d+\.\d+/.test(version.trim())) {
      setError("Version must be semver (e.g. 1.4.0)");
      return;
    }
    setPublishing(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("version", version.trim());
      const res = await fetch("/api/tally/update-package", { method: "POST", body: fd });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      toast.success(`Bridge v${version.trim()} published. Bridge will self-update on next heartbeat (~60s).`);
      setFile(null);
      setVersion("");
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Publish failed";
      setError(msg);
      toast.error(msg);
    } finally {
      setPublishing(false);
    }
  }

  async function handleUnpublish() {
    if (!confirm("Unpublish the bridge update target? Bridges that haven't already picked it up will not update.")) return;
    setUnpublishing(true);
    setError(null);
    try {
      const res = await fetch("/api/tally/update-package", { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      toast.success("Bridge target version cleared.");
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unpublish failed";
      setError(msg);
      toast.error(msg);
    } finally {
      setUnpublishing(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <PackageOpen className="h-4 w-4" />
          Publish Bridge Update
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Current published state */}
        <div className="rounded border bg-muted/30 p-3 text-xs space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Currently published target</span>
            <button type="button" onClick={() => void refresh()} className="text-muted-foreground hover:text-foreground" aria-label="Refresh">
              <RefreshCw className="h-3 w-3" />
            </button>
          </div>
          {state.target_version ? (
            <>
              <div>Version: <span className="font-mono font-medium">{state.target_version}</span></div>
              {state.sha256 && (
                <div className="text-muted-foreground">
                  SHA-256: <span className="font-mono">{state.sha256.slice(0, 16)}…{state.sha256.slice(-8)}</span>
                </div>
              )}
              {state.published_at && (
                <div className="text-muted-foreground">Published: {new Date(state.published_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST</div>
              )}
            </>
          ) : (
            <div className="text-muted-foreground italic">No target version published. Bridges run their installed version.</div>
          )}
        </div>

        {/* Upload form */}
        <form onSubmit={handlePublish} onKeyDown={preventEnterSubmit} className="space-y-3">
          <div>
            <Label htmlFor="bridge-zip" className="text-xs">Bridge release zip (must contain dist/)</Label>
            <Input
              id="bridge-zip"
              type="file"
              accept=".zip,application/zip"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              disabled={publishing}
              className="text-xs"
            />
            {file && (
              <div className="text-xs text-muted-foreground mt-1">
                {file.name} · {(file.size / 1024 / 1024).toFixed(2)} MB
              </div>
            )}
          </div>
          <div>
            <Label htmlFor="bridge-version" className="text-xs">Version (semver)</Label>
            <Input
              id="bridge-version"
              type="text"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              placeholder="e.g. 1.4.0"
              disabled={publishing}
              className="text-xs font-mono"
            />
          </div>

          {error && (
            <div className="text-xs text-red-900 bg-red-50 border border-red-200 rounded p-2 flex items-start gap-1">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" aria-hidden />
              <span>{error}</span>
            </div>
          )}

          <div className="flex items-center gap-2">
            <Button
              type="submit"
              disabled={!file || !version.trim() || publishing}
              className="inline-flex items-center gap-1"
            >
              {publishing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              {publishing ? "Publishing…" : "Publish update"}
            </Button>
            {state.target_version && (
              <Button
                type="button"
                variant="outline"
                onClick={handleUnpublish}
                disabled={unpublishing}
                className="inline-flex items-center gap-1"
              >
                {unpublishing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                {unpublishing ? "Clearing…" : "Unpublish"}
              </Button>
            )}
          </div>
        </form>

        <div className="text-[11px] text-muted-foreground border-t pt-3 space-y-1">
          <div className="flex items-start gap-1">
            <CheckCircle2 className="h-3 w-3 mt-0.5 flex-shrink-0 text-green-700" aria-hidden />
            <span>Bridge picks up the new version on next heartbeat (~60s) and self-updates between poll cycles.</span>
          </div>
          <div className="flex items-start gap-1">
            <AlertCircle className="h-3 w-3 mt-0.5 flex-shrink-0 text-amber-700" aria-hidden />
            <span>Tally machine must be on for the bridge to fetch + apply the update. Outside business hours: queued.</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
