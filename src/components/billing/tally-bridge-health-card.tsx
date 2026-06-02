"use client";

/**
 * TallyBridgeHealthCard
 *
 * Shows the bridge connection status in the CRM (§7.2 of the design doc).
 * Polls /api/tally/health-status every 60s. Flips to "Bridge offline" if
 * last_seen_at is >90s ago (the bridge pings every ~60s).
 *
 * States:
 *   🟢 green  — bridge running, Tally connected, queue clear
 *   🟡 amber  — connected but degraded (wrong company, jobs pending/failed)
 *   🔴 red    — bridge offline (no heartbeat for >90s) or Tally disconnected
 *   ⚪ grey   — integration not yet enabled (tally_sync_enabled = false)
 */

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RefreshCw, Wifi, WifiOff, AlertTriangle, CheckCircle2, Clock } from "lucide-react";
import { formatDate } from "@/lib/utils";

interface BridgeHealth {
  online: boolean;
  tally_connected: boolean;
  tally_company_name: string | null;
  tally_company_gstin: string | null;
  gstin_mismatch: boolean;
  pending_count: number;
  failed_count: number;
  last_seen_at: string | null;
  last_sync_at: string | null;
  version: string | null;
  sync_enabled: boolean;
}

type HealthStatus = "disabled" | "offline" | "degraded" | "healthy";

function getStatus(h: BridgeHealth): HealthStatus {
  if (!h.sync_enabled) return "disabled";
  if (!h.online || !h.tally_connected) return "offline";
  if (h.failed_count > 0 || h.gstin_mismatch || h.pending_count > 10) return "degraded";
  return "healthy";
}

const STATUS_CONFIG: Record<HealthStatus, {
  label: string;
  icon: React.ElementType;
  badgeVariant: "default" | "secondary" | "destructive" | "outline";
  color: string;
}> = {
  healthy:  { label: "Connected",     icon: CheckCircle2,   badgeVariant: "default",     color: "text-green-600" },
  degraded: { label: "Degraded",      icon: AlertTriangle,  badgeVariant: "secondary",   color: "text-yellow-600" },
  offline:  { label: "Bridge offline",icon: WifiOff,        badgeVariant: "destructive",  color: "text-red-600" },
  disabled: { label: "Not enabled",   icon: Wifi,           badgeVariant: "outline",      color: "text-muted-foreground" },
};

export function TallyBridgeHealthCard() {
  const [health, setHealth] = useState<BridgeHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  async function fetchHealth() {
    try {
      const res = await fetch("/api/tally/health-status");
      if (res.ok) {
        const data = await res.json() as BridgeHealth;
        setHealth(data);
      }
    } catch {
      // Network error — card will show stale or null state
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void fetchHealth();
    const interval = setInterval(() => void fetchHealth(), 60_000);
    return () => clearInterval(interval);
  }, []);

  const status = health ? getStatus(health) : "offline";
  const cfg = STATUS_CONFIG[status];
  const Icon = cfg.icon;

  return (
    <Card className="w-full">
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Tally Bridge
        </CardTitle>
        <button
          onClick={() => { setRefreshing(true); void fetchHealth(); }}
          className="text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Refresh"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
        </button>
      </CardHeader>

      <CardContent className="space-y-3">
        {loading ? (
          <div className="text-sm text-muted-foreground">Checking…</div>
        ) : (
          <>
            {/* Status badge */}
            <div className="flex items-center gap-2">
              <Icon className={`h-4 w-4 ${cfg.color}`} />
              <Badge variant={cfg.badgeVariant} className="text-xs">
                {cfg.label}
              </Badge>
              {health?.version && (
                <span className="text-xs text-muted-foreground">v{health.version}</span>
              )}
            </div>

            {/* Company name */}
            {health?.tally_company_name && (
              <div className="text-xs text-muted-foreground truncate">
                {health.tally_company_name}
                {health.gstin_mismatch && (
                  <span className="text-destructive ml-1">(wrong company!)</span>
                )}
              </div>
            )}

            {/* Queue counts */}
            {(health?.pending_count !== undefined || health?.failed_count !== undefined) && (
              <div className="flex gap-3 text-xs">
                <span className="text-muted-foreground">
                  Pending: <span className="font-medium text-foreground">{health?.pending_count ?? 0}</span>
                </span>
                <span className={health?.failed_count ? "text-destructive font-medium" : "text-muted-foreground"}>
                  Failed: <span className="font-medium">{health?.failed_count ?? 0}</span>
                </span>
              </div>
            )}

            {/* Last seen */}
            {health?.last_seen_at && (
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Clock className="h-3 w-3" />
                Last seen {formatDate(health.last_seen_at)}
              </div>
            )}

            {/* Failed jobs CTA */}
            {health && health.failed_count > 0 && (
              <a
                href="/billing?tally_status=failed"
                className="text-xs text-destructive underline underline-offset-2 hover:no-underline"
              >
                View {health.failed_count} failed invoice{health.failed_count > 1 ? "s" : ""} →
              </a>
            )}

            {/* Disabled state */}
            {status === "disabled" && (
              <p className="text-xs text-muted-foreground">
                Integration not yet enabled. Set{" "}
                <code className="text-xs bg-muted px-1 py-0.5 rounded">tally_sync_enabled = true</code>{" "}
                in Settings when the bridge is live.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
