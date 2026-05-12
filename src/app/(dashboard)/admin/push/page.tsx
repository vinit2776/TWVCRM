"use client";

/**
 * Admin → Push broadcast
 *
 * Compose + broadcast a Web Push notification to every subscribed device,
 * then watch live stats (sent / failed / delivered / clicked) come in from
 * the SW beacons.
 *
 * iOS caveat is surfaced inline — Web Push on iOS only works when the user
 * has installed the PWA to the Home Screen (iOS 16.4+). Users on plain
 * Safari are NOT in the subscriber count.
 */

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { BellRing, Loader2, Send, Users, Smartphone, AlertTriangle, RefreshCw } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

interface BatchStat {
  batchId: string;
  title: string;
  body: string;
  url?: string;
  createdAt: string;
  total: number;
  sent: number;
  failed: number;
  delivered: number;
  clicked: number;
}

interface StatsResponse {
  subscribers: number;
  batches: BatchStat[];
}

export default function AdminPushPage() {
  const [title, setTitle]     = useState("");
  const [body, setBody]       = useState("");
  const [url, setUrl]         = useState("/");
  const [eligible, setEligible] = useState<number | null>(null);
  const [sending, setSending]   = useState(false);
  const [stats, setStats]       = useState<StatsResponse | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const loadStats = useCallback(async () => {
    const res = await fetch("/api/push/stats", { cache: "no-store" });
    if (!res.ok) return;
    const json = (await res.json()) as StatsResponse;
    setStats(json);
    setEligible(json.subscribers);
  }, []);

  useEffect(() => { loadStats(); }, [loadStats]);

  // Poll stats while a broadcast is in flight + for 60s afterwards so the
  // beacons trickle in. Web Push delivery is async — devices may be offline.
  const [pollUntil, setPollUntil] = useState(0);
  useEffect(() => {
    if (Date.now() > pollUntil) return;
    const t = setInterval(() => {
      loadStats();
      if (Date.now() > pollUntil) clearInterval(t);
    }, 3000);
    return () => clearInterval(t);
  }, [pollUntil, loadStats]);

  const fire = async () => {
    setSending(true);
    setConfirmOpen(false);
    try {
      const res = await fetch("/api/push/broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, body, url }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Broadcast failed");
        return;
      }
      toast.success(`Sent ${json.sent}/${json.total} (failed: ${json.failed})`);
      // Poll for the next 90s so delivered/clicked rates fill in.
      setPollUntil(Date.now() + 90_000);
      loadStats();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Network error");
    } finally {
      setSending(false);
    }
  };

  const canSend = title.trim().length > 0 && body.trim().length > 0 && !sending;

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto space-y-6">
      <header>
        <h1 className="text-xl md:text-2xl font-semibold flex items-center gap-2">
          <BellRing className="h-5 w-5" /> Push broadcast
        </h1>
        <p className="text-xs md:text-sm text-muted-foreground mt-1">
          Send a Web Push notification to every device that has enabled
          notifications. The service worker beacons delivered / clicked
          events back so you can measure reach.
        </p>
      </header>

      {/* iOS caveat — load-bearing for users who wonder why iPhones don't get the push */}
      <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 flex gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
        <div>
          <strong>iOS only receives push when the PWA is installed.</strong>
          {" "}Users on Safari (not installed to Home Screen) are NOT in the subscriber
          count — they need to tap Share → Add to Home Screen, then enable
          notifications from the installed app.
        </div>
      </div>

      {/* Composer */}
      <section className="rounded-lg border bg-card p-4 space-y-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium">Title</label>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="TWV CRM"
            maxLength={60}
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium">Body</label>
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="What should we tell people?"
            rows={3}
            maxLength={200}
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium">Tap-to-open URL (optional)</label>
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="/"
          />
        </div>

        <div className="flex items-center gap-3 pt-1">
          <div className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Users className="h-3.5 w-3.5" />
            {eligible === null ? "—" : `${eligible} subscribed device${eligible === 1 ? "" : "s"}`}
          </div>
          <div className="flex-1" />
          <Button
            disabled={!canSend}
            onClick={() => setConfirmOpen(true)}
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            <span className="ml-1.5">Send to all</span>
          </Button>
        </div>
      </section>

      {/* Confirm dialog — inline, so the admin sees exact payload before firing */}
      {confirmOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
          onClick={() => setConfirmOpen(false)}
        >
          <div
            className="bg-white rounded-lg shadow-xl max-w-md w-full p-5 space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-semibold flex items-center gap-2">
              <Smartphone className="h-4 w-4" /> Send this to {eligible ?? "?"} device{eligible === 1 ? "" : "s"}?
            </h3>
            <div className="rounded-md border bg-muted/40 p-3 space-y-1">
              <p className="text-sm font-medium">{title || "(empty title)"}</p>
              <p className="text-xs text-muted-foreground">{body || "(empty body)"}</p>
              {url && url !== "/" && <p className="text-[10px] text-muted-foreground">Opens: {url}</p>}
            </div>
            <p className="text-xs text-muted-foreground">
              This sends a real push notification to every subscribed device.
              It cannot be recalled once sent.
            </p>
            <div className="flex items-center justify-end gap-2 pt-1">
              <Button variant="outline" onClick={() => setConfirmOpen(false)}>Cancel</Button>
              <Button onClick={fire} disabled={sending}>
                {sending ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : null}
                Confirm + send
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Stats — recent batches */}
      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Recent broadcasts</h2>
          <button
            onClick={loadStats}
            className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            <RefreshCw className="h-3 w-3" /> refresh
          </button>
        </div>
        <div className="rounded-lg border overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-muted/40">
              <tr>
                <th className="text-left px-3 py-2 font-medium">When</th>
                <th className="text-left px-3 py-2 font-medium">Message</th>
                <th className="text-right px-3 py-2 font-medium">Total</th>
                <th className="text-right px-3 py-2 font-medium">Sent</th>
                <th className="text-right px-3 py-2 font-medium">Failed</th>
                <th className="text-right px-3 py-2 font-medium">Delivered</th>
                <th className="text-right px-3 py-2 font-medium">Clicked</th>
              </tr>
            </thead>
            <tbody>
              {!stats?.batches.length ? (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">
                    No broadcasts yet.
                  </td>
                </tr>
              ) : stats.batches.map((b) => {
                const reach = b.sent > 0 ? Math.round((b.delivered / b.sent) * 100) : 0;
                const ctr   = b.delivered > 0 ? Math.round((b.clicked / b.delivered) * 100) : 0;
                return (
                  <tr key={b.batchId} className="border-t">
                    <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                      {new Date(b.createdAt).toLocaleString()}
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium truncate max-w-[260px]">{b.title}</div>
                      <div className="text-muted-foreground truncate max-w-[260px]">{b.body}</div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{b.total}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{b.sent}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-red-600">{b.failed || ""}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {b.delivered}
                      {b.sent > 0 && <span className="text-muted-foreground ml-1">({reach}%)</span>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {b.clicked}
                      {b.delivered > 0 && <span className="text-muted-foreground ml-1">({ctr}%)</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-[10px] text-muted-foreground">
          Reach % = delivered/sent (devices that woke up).
          Click % = clicked/delivered (engagement).
          Delivered events trickle in for ~1 minute after send as devices come online.
        </p>
      </section>
    </div>
  );
}
