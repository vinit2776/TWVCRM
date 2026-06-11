"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Database,
  Server,
  Mail,
  Globe,
  HardDrive,
  MemoryStick,
  Network,
  Users,
  FolderOpen,
  RefreshCw,
  ExternalLink,
  TableProperties,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Send,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/shared/loading-skeleton";

// ── Types ──

interface InfraData {
  fetched_at: string;
  supabase: {
    plan: string;
    project_ref: string;
    database: { used_bytes: number; total_bytes: number; percent: number };
    memory: { used_bytes: number; total_bytes: number; percent: number };
    connections: { max: number };
    auth_users: { count: number; limit: number };
    storage: { bucket_count: number; file_count: number; limit_bytes: number };
    tables: Array<{ name: string; row_count: number }>;
    total_rows: number;
  };
  vercel: {
    plan: string;
    limits: Record<string, number>;
    usage: { bandwidth_used_gb: number; build_minutes_used: number };
    has_token: boolean;
    dashboard_url: string;
  };
  google_workspace: {
    smtp_user: string;
    smtp_port: number;
    connected: boolean;
    daily_limit: number;
    sent_today: number;
    failed_today: number;
    dashboard_url: string;
  };
  resend: {
    configured: boolean;
    domain_name: string | null;
    domain_status: string;
    sent_today: number;
    failed_today: number;
    sent_this_month: number;
    failed_this_month: number;
    monthly_limit: number;
  };
}

// ── Helpers ──

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i >= 2 ? 1 : 0)} ${units[i]}`;
}

function getUsageColor(percent: number): string {
  if (percent >= 80) return "bg-red-500";
  if (percent >= 60) return "bg-amber-500";
  return "bg-emerald-500";
}

function getUsageTextColor(percent: number): string {
  if (percent >= 80) return "text-red-600";
  if (percent >= 60) return "text-amber-600";
  return "text-emerald-600";
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat("en-IN").format(n);
}

function formatExactTime(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const TABLE_LABELS: Record<string, string> = {
  leads: "Leads",
  activities: "Activities",
  tasks: "Tasks",
  proposals: "Proposals",
  contracts: "Contracts",
  voucher_repository: "Voucher Repository",
  bookings: "Bookings",
  users: "Users",
  locations: "Locations",
  spaces: "Spaces",
  invoices: "Invoices",
  audit_logs: "Audit Logs",
  voucher_issuances: "Voucher Issuances",
  booking_facilities: "Booking Facilities",
  usage_charges: "Usage Charges",
};

// ── Progress Bar Component ──

function UsageMeter({
  label,
  used,
  total,
  percent,
  icon: Icon,
  formatFn = formatBytes,
}: {
  label: string;
  used: number;
  total: number;
  percent: number;
  icon: React.ComponentType<{ className?: string }>;
  formatFn?: (n: number) => string;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium">{label}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="flex items-baseline gap-2">
          <span className={`text-2xl font-bold ${getUsageTextColor(percent)}`}>
            {percent}%
          </span>
          <span className="text-xs text-muted-foreground">
            {formatFn(used)} / {formatFn(total)}
          </span>
        </div>
        <div className="mt-3 h-2.5 w-full rounded-full bg-muted overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${getUsageColor(percent)}`}
            style={{ width: `${Math.min(percent, 100)}%` }}
          />
        </div>
        {percent >= 80 && (
          <p className="mt-2 text-xs text-red-600 flex items-center gap-1">
            <AlertTriangle className="h-3 w-3" />
            Nearing capacity — consider upgrading
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ── Cache ──

const CACHE_KEY = "twv_infra_data";
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

// ── Main Page ──

export default function InfrastructurePage() {
  const [data, setData] = useState<InfraData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  // ref so fetchData doesn't need `data` as a closure dep (avoids infinite loop)
  const hasDataRef = useRef(false);

  const fetchData = useCallback(async (force = false) => {
    if (!force) {
      try {
        const cached = localStorage.getItem(CACHE_KEY);
        if (cached) {
          const parsed = JSON.parse(cached) as InfraData;
          if (Date.now() - new Date(parsed.fetched_at).getTime() < CACHE_TTL) {
            setData(parsed);
            hasDataRef.current = true;
            setLoading(false);
            return;
          }
        }
      } catch { /* cache read error — fetch fresh */ }
    }

    if (force && hasDataRef.current) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError("");

    try {
      const res = await fetch("/api/admin/infrastructure");
      if (!res.ok) {
        const err = await res.json().catch(() => null) as { error?: string } | null;
        setError(err?.error || "Failed to fetch infrastructure data");
        return;
      }
      const json = await res.json() as InfraData;
      setData(json);
      hasDataRef.current = true;
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(json)); } catch { /* storage full */ }
    } catch {
      setError("Failed to connect to API");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []); // no state deps — uses ref to avoid infinite loop

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-4 w-96 mt-2" />
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-36" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Infrastructure</h1>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <AlertTriangle className="h-12 w-12 text-red-500 mb-4" />
            <p className="text-lg font-medium">{error}</p>
            <p className="text-sm text-muted-foreground mt-1">Only admins can access this page.</p>
            <Button className="mt-4" onClick={() => fetchData(true)}>Retry</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!data) return null;

  const sb = data.supabase;
  const gw = data.google_workspace;
  const rs = data.resend;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Infrastructure</h1>
          <p className="text-sm text-muted-foreground flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5" />
            Last refreshed {formatExactTime(data.fetched_at)}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => fetchData(true)}
          disabled={refreshing}
        >
          <RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          {refreshing ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      {/* ── Section 1: Service Overview ── */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">

        {/* Supabase */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Database className="h-4 w-4 text-emerald-600" />
              Supabase
            </CardTitle>
            <Badge variant="secondary" className="text-xs">{sb.plan}</Badge>
          </CardHeader>
          <CardContent>
            <div className="space-y-1 text-sm">
              <div className="flex items-center gap-2">
                <div className={`h-2 w-2 rounded-full shrink-0 ${sb.database.percent >= 80 ? "bg-red-500" : sb.database.percent >= 60 ? "bg-amber-500" : "bg-emerald-500"}`} />
                <span>DB Disk: <strong>{sb.database.percent}%</strong></span>
              </div>
              <div className="flex items-center gap-2">
                <div className={`h-2 w-2 rounded-full shrink-0 ${sb.memory.percent >= 80 ? "bg-red-500" : sb.memory.percent >= 60 ? "bg-amber-500" : "bg-emerald-500"}`} />
                <span>Memory: <strong>{sb.memory.percent}%</strong></span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-2 w-2 rounded-full bg-blue-500 shrink-0" />
                <span>{formatNumber(sb.total_rows)} rows</span>
              </div>
            </div>
            <a
              href={`https://supabase.com/dashboard/project/${sb.project_ref}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline mt-3"
            >
              Open Dashboard <ExternalLink className="h-3 w-3" />
            </a>
          </CardContent>
        </Card>

        {/* Vercel */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Globe className="h-4 w-4" />
              Vercel
            </CardTitle>
            <Badge variant="secondary" className="text-xs">{data.vercel.plan}</Badge>
          </CardHeader>
          <CardContent>
            {data.vercel.has_token ? (
              <div className="space-y-3">
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-muted-foreground">Bandwidth</span>
                    <span className={getUsageTextColor(Math.round((data.vercel.usage.bandwidth_used_gb / data.vercel.limits.bandwidth_gb) * 100))}>
                      {data.vercel.usage.bandwidth_used_gb} / {data.vercel.limits.bandwidth_gb} GB
                    </span>
                  </div>
                  <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      className={`h-full rounded-full ${getUsageColor(Math.round((data.vercel.usage.bandwidth_used_gb / data.vercel.limits.bandwidth_gb) * 100))}`}
                      style={{ width: `${Math.min((data.vercel.usage.bandwidth_used_gb / data.vercel.limits.bandwidth_gb) * 100, 100)}%` }}
                    />
                  </div>
                </div>
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-muted-foreground">Build Minutes</span>
                    <span className={getUsageTextColor(Math.round((data.vercel.usage.build_minutes_used / data.vercel.limits.build_minutes_per_month) * 100))}>
                      {formatNumber(data.vercel.usage.build_minutes_used)} / {formatNumber(data.vercel.limits.build_minutes_per_month)} min
                    </span>
                  </div>
                  <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      className={`h-full rounded-full ${getUsageColor(Math.round((data.vercel.usage.build_minutes_used / data.vercel.limits.build_minutes_per_month) * 100))}`}
                      style={{ width: `${Math.min((data.vercel.usage.build_minutes_used / data.vercel.limits.build_minutes_per_month) * 100, 100)}%` }}
                    />
                  </div>
                </div>
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Fn timeout</span>
                  <span>{data.vercel.limits.serverless_function_timeout_sec}s</span>
                </div>
              </div>
            ) : (
              <div className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Bandwidth</span>
                  <span>{data.vercel.limits.bandwidth_gb} GB/mo</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Build Minutes</span>
                  <span>{formatNumber(data.vercel.limits.build_minutes_per_month)}/mo</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Edge Requests</span>
                  <span>{(data.vercel.limits.edge_requests / 1_000_000).toFixed(0)}M/mo</span>
                </div>
                <p className="text-xs text-amber-600 mt-2 flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3 shrink-0" />
                  Set <code className="font-mono">VERCEL_API_TOKEN</code> for live usage
                </p>
              </div>
            )}
            <a
              href={data.vercel.dashboard_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline mt-3"
            >
              View Dashboard <ExternalLink className="h-3 w-3" />
            </a>
          </CardContent>
        </Card>

        {/* Google Workspace */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Mail className="h-4 w-4 text-blue-600" />
              Google Workspace
            </CardTitle>
            <Badge
              variant="secondary"
              className={`text-xs ${gw.connected ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}
            >
              {gw.connected ? "Connected" : "Disconnected"}
            </Badge>
          </CardHeader>
          <CardContent>
            <div className="space-y-1 text-sm">
              <div className="flex items-center gap-2">
                <div className={`h-2 w-2 rounded-full shrink-0 ${gw.connected ? "bg-emerald-500" : "bg-red-500"}`} />
                <span className="text-muted-foreground truncate text-xs">{gw.smtp_user}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Protocol</span>
                <span>SMTP port {gw.smtp_port}</span>
              </div>
            </div>
            <div className="mt-3">
              <div className="flex justify-between text-xs mb-1">
                <span className="text-muted-foreground">Sent today</span>
                <span className={getUsageTextColor(Math.round((gw.sent_today / gw.daily_limit) * 100))}>
                  {formatNumber(gw.sent_today)} / {formatNumber(gw.daily_limit)}
                </span>
              </div>
              <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className={`h-full rounded-full ${getUsageColor(Math.round((gw.sent_today / gw.daily_limit) * 100))}`}
                  style={{ width: `${Math.min((gw.sent_today / gw.daily_limit) * 100, 100)}%` }}
                />
              </div>
              {gw.failed_today > 0 && (
                <p className="mt-1 text-xs text-amber-600 flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3" />
                  {gw.failed_today} failed today
                </p>
              )}
            </div>
            <a
              href={gw.dashboard_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline mt-3"
            >
              Admin Console <ExternalLink className="h-3 w-3" />
            </a>
          </CardContent>
        </Card>

        {/* Resend */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Send className="h-4 w-4 text-purple-600" />
              Resend
            </CardTitle>
            <Badge
              variant="secondary"
              className={`text-xs ${
                !rs.configured
                  ? "bg-muted text-muted-foreground"
                  : rs.domain_status === "verified"
                  ? "bg-emerald-100 text-emerald-700"
                  : "bg-amber-100 text-amber-700"
              }`}
            >
              {!rs.configured ? "Not configured" : rs.domain_status === "verified" ? "Verified" : rs.domain_status}
            </Badge>
          </CardHeader>
          <CardContent>
            {rs.configured ? (
              <>
                <div className="space-y-1 text-sm">
                  {rs.domain_name && (
                    <div className="flex items-center gap-2">
                      <div className={`h-2 w-2 rounded-full shrink-0 ${rs.domain_status === "verified" ? "bg-emerald-500" : "bg-amber-500"}`} />
                      <span className="text-muted-foreground text-xs truncate">{rs.domain_name}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Role</span>
                    <span>SMTP fallback</span>
                  </div>
                </div>
                <div className="mt-3 space-y-1.5">
                  <div>
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-muted-foreground">This month</span>
                      <span className={getUsageTextColor(Math.round((rs.sent_this_month / rs.monthly_limit) * 100))}>
                        {formatNumber(rs.sent_this_month)} / {formatNumber(rs.monthly_limit)}
                      </span>
                    </div>
                    <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                      <div
                        className={`h-full rounded-full ${getUsageColor(Math.round((rs.sent_this_month / rs.monthly_limit) * 100))}`}
                        style={{ width: `${Math.min((rs.sent_this_month / rs.monthly_limit) * 100, 100)}%` }}
                      />
                    </div>
                  </div>
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Today</span>
                    <span>{formatNumber(rs.sent_today)} sent{rs.failed_today > 0 ? `, ${rs.failed_today} failed` : ""}</span>
                  </div>
                </div>
                {rs.failed_this_month > 0 && (
                  <p className="mt-1 text-xs text-amber-600 flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" />
                    {rs.failed_this_month} failed this month
                  </p>
                )}
              </>
            ) : (
              <p className="text-xs text-muted-foreground mt-1">
                Set <code className="font-mono">RESEND_API_KEY</code> to enable the SMTP fallback transport.
              </p>
            )}
            <a
              href="https://resend.com/overview"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline mt-3"
            >
              Resend Dashboard <ExternalLink className="h-3 w-3" />
            </a>
          </CardContent>
        </Card>
      </div>

      {/* ── Section 2: Supabase Deep Dive ── */}
      <div>
        <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
          <Database className="h-5 w-5 text-emerald-600" />
          Supabase — Resource Usage
        </h2>
        <div className="grid gap-4 md:grid-cols-2">
          <UsageMeter
            label="Database Disk"
            used={sb.database.used_bytes}
            total={sb.database.total_bytes}
            percent={sb.database.percent}
            icon={HardDrive}
          />
          <UsageMeter
            label="Memory"
            used={sb.memory.used_bytes}
            total={sb.memory.total_bytes}
            percent={sb.memory.percent}
            icon={MemoryStick}
          />

          {/* Auth Users */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Auth Users</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold">{sb.auth_users.count}</span>
                <span className="text-xs text-muted-foreground">
                  / {formatNumber(sb.auth_users.limit)} MAU limit
                </span>
              </div>
              <div className="mt-3 h-2.5 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-emerald-500 transition-all"
                  style={{ width: `${Math.max((sb.auth_users.count / sb.auth_users.limit) * 100, 0.5)}%` }}
                />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {((sb.auth_users.count / sb.auth_users.limit) * 100).toFixed(2)}% of free tier limit
              </p>
            </CardContent>
          </Card>

          {/* Storage + Connections */}
          <div className="space-y-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium">File Storage</CardTitle>
                <FolderOpen className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="flex items-baseline gap-2">
                  <span className="text-2xl font-bold">{sb.storage.file_count}</span>
                  <span className="text-xs text-muted-foreground">
                    files across {sb.storage.bucket_count} bucket{sb.storage.bucket_count !== 1 ? "s" : ""}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Free tier: {formatBytes(sb.storage.limit_bytes)} limit
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium">DB Connections</CardTitle>
                <Network className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="flex items-baseline gap-2">
                  <span className="text-2xl font-bold">{sb.connections.max}</span>
                  <span className="text-xs text-muted-foreground">
                    max client connections (PgBouncer)
                  </span>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>

      {/* ── Section 3: Email Summary ── */}
      <div>
        <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
          <Mail className="h-5 w-5 text-blue-600" />
          Email — This Month
        </h2>
        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Total Sent</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold">{formatNumber(rs.sent_this_month)}</p>
              <p className="text-xs text-muted-foreground mt-1">{formatNumber(rs.sent_today)} today</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Failed</CardTitle>
            </CardHeader>
            <CardContent>
              <p className={`text-3xl font-bold ${rs.failed_this_month > 0 ? "text-amber-600" : "text-emerald-600"}`}>
                {formatNumber(rs.failed_this_month)}
              </p>
              <p className="text-xs text-muted-foreground mt-1">{formatNumber(rs.failed_today)} today</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Delivery Rate</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold">
                {rs.sent_this_month + rs.failed_this_month > 0
                  ? ((rs.sent_this_month / (rs.sent_this_month + rs.failed_this_month)) * 100).toFixed(1)
                  : "—"}
                {rs.sent_this_month + rs.failed_this_month > 0 ? "%" : ""}
              </p>
              <p className="text-xs text-muted-foreground mt-1">Primary: SMTP · Fallback: Resend</p>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ── Section 4: Database Tables ── */}
      <div>
        <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
          <TableProperties className="h-5 w-5" />
          Database Tables — {formatNumber(sb.total_rows)} total rows
        </h2>
        <Card>
          <CardContent className="p-0">
            <div className="rounded-md overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-4 py-3 text-left font-medium">Table</th>
                    <th className="px-4 py-3 text-right font-medium">Rows</th>
                    <th className="px-4 py-3 text-right font-medium hidden sm:table-cell">% of Total</th>
                  </tr>
                </thead>
                <tbody>
                  {sb.tables.map((table, i) => {
                    const pct = sb.total_rows > 0
                      ? ((table.row_count / sb.total_rows) * 100).toFixed(1)
                      : "0";
                    return (
                      <tr key={table.name} className={`border-b transition-colors ${i % 2 === 0 ? "" : "bg-muted/20"}`}>
                        <td className="px-4 py-2.5 font-medium">
                          {TABLE_LABELS[table.name] || table.name}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono text-xs">
                          {formatNumber(table.row_count)}
                        </td>
                        <td className="px-4 py-2.5 text-right hidden sm:table-cell">
                          <div className="flex items-center justify-end gap-2">
                            <div className="w-20 h-1.5 rounded-full bg-muted overflow-hidden">
                              <div
                                className="h-full rounded-full bg-primary/60"
                                style={{ width: `${Math.min(parseFloat(pct), 100)}%` }}
                              />
                            </div>
                            <span className="text-xs text-muted-foreground w-12 text-right">{pct}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Footer */}
      <p className="text-xs text-muted-foreground text-center pb-4">
        Cached locally for 24 hours. Hit &quot;Refresh&quot; to fetch live metrics.
        Email counts are tracked from this app&apos;s send log — not pulled from provider APIs.
      </p>
    </div>
  );
}
