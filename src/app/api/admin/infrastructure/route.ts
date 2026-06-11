import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { transporter } from "@/lib/mailer";

export const dynamic = "force-dynamic";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SUPABASE_REF = SUPABASE_URL.replace("https://", "").replace(".supabase.co", "");

const TABLES = [
  "leads",
  "activities",
  "tasks",
  "proposals",
  "contracts",
  "voucher_repository",
  "bookings",
  "users",
  "locations",
  "spaces",
  "invoices",
  "audit_logs",
  "voucher_issuances",
  "booking_facilities",
  "usage_charges",
];

function parsePrometheusMetric(
  text: string,
  metricName: string,
  labels?: Record<string, string>
): number | null {
  const lines = text.split("\n");
  for (const line of lines) {
    if (line.startsWith("#") || !line.startsWith(metricName)) continue;
    if (labels) {
      let allMatch = true;
      for (const [key, value] of Object.entries(labels)) {
        if (!line.includes(`${key}="${value}"`)) { allMatch = false; break; }
      }
      if (!allMatch) continue;
    }
    const parts = line.split(/\s+/);
    const val = parseFloat(parts[parts.length - 1]);
    if (!isNaN(val)) return val;
  }
  return null;
}

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || dbUser.role !== "admin") {
    return NextResponse.json({ error: "Only admins can access infrastructure data" }, { status: 403 });
  }

  // ── 1. Supabase Prometheus Metrics ──
  let metricsText = "";
  try {
    const metricsRes = await fetch(`${SUPABASE_URL}/customer/v1/privileged/metrics`, {
      headers: {
        Authorization: "Basic " + Buffer.from(`service_role:${SERVICE_ROLE_KEY}`).toString("base64"),
      },
      cache: "no-store",
    });
    if (metricsRes.ok) metricsText = await metricsRes.text();
  } catch { /* unavailable */ }

  const diskTotal = parsePrometheusMetric(metricsText, "node_filesystem_size_bytes", { mountpoint: "/data" }) || 0;
  const diskAvailable = parsePrometheusMetric(metricsText, "node_filesystem_avail_bytes", { mountpoint: "/data" }) || 0;
  const diskUsed = diskTotal - diskAvailable;
  const memTotal = parsePrometheusMetric(metricsText, "node_memory_MemTotal_bytes") || 0;
  const memAvailable = parsePrometheusMetric(metricsText, "node_memory_MemAvailable_bytes") || 0;
  const memUsed = memTotal - memAvailable;
  const maxConnections = parsePrometheusMetric(metricsText, "pgbouncer_config_max_client_connections") || 200;

  // ── 2. Row Counts ──
  const countResults = await Promise.all(
    TABLES.map(async (table) => {
      try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=id&limit=1`, {
          method: "GET",
          headers: {
            apikey: SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
            Prefer: "count=exact",
          },
          cache: "no-store",
        });
        const range = res.headers.get("content-range");
        const count = range ? parseInt(range.split("/")[1] || "0", 10) : 0;
        return { name: table, row_count: isNaN(count) ? 0 : count };
      } catch {
        return { name: table, row_count: 0 };
      }
    })
  );
  const tableCounts = countResults.sort((a, b) => b.row_count - a.row_count);
  const totalRows = tableCounts.reduce((sum, t) => sum + t.row_count, 0);

  // ── 3. Storage ──
  let bucketCount = 0;
  let fileCount = 0;
  try {
    const bucketsRes = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
      headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
      cache: "no-store",
    });
    if (bucketsRes.ok) {
      const buckets = await bucketsRes.json();
      bucketCount = Array.isArray(buckets) ? buckets.length : 0;
      for (const bucket of buckets) {
        try {
          const listRes = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${bucket.id}`, {
            method: "POST",
            headers: {
              apikey: SERVICE_ROLE_KEY,
              Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ limit: 1000, offset: 0 }),
            cache: "no-store",
          });
          if (listRes.ok) {
            const files = await listRes.json();
            fileCount += Array.isArray(files) ? files.length : 0;
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* unavailable */ }

  // ── 4. Vercel Usage ──
  let vercelUsage = { bandwidth_used_gb: 0, build_minutes_used: 0 };
  const vercelToken = process.env.VERCEL_API_TOKEN;
  if (vercelToken) {
    try {
      const teamQuery = process.env.VERCEL_TEAM_ID ? `?teamId=${process.env.VERCEL_TEAM_ID}` : "";
      const vRes = await fetch(`https://api.vercel.com/v2/usage${teamQuery}`, {
        headers: { Authorization: `Bearer ${vercelToken}` },
        cache: "no-store",
      });
      if (vRes.ok) {
        const vData = await vRes.json();
        vercelUsage = {
          bandwidth_used_gb: parseFloat(((vData.data?.bandwidth?.usage || 0) / 1e9).toFixed(2)),
          build_minutes_used: Math.round((vData.data?.buildMinutes?.usage || 0) / 60),
        };
      }
    } catch { /* unavailable */ }
  }

  // ── 5. Email Stats (today + this month) ──
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 7) + "-01"; // YYYY-MM-01

  const { data: emailStat } = await supabase
    .from("email_daily_stats")
    .select("sent_count, failed_count")
    .eq("date", today)
    .maybeSingle();
  const emailsSentToday = emailStat?.sent_count || 0;
  const emailsFailedToday = emailStat?.failed_count || 0;

  const { data: monthlyStats } = await supabase
    .from("email_daily_stats")
    .select("sent_count, failed_count")
    .gte("date", monthStart)
    .lte("date", today);
  const emailsSentThisMonth = (monthlyStats || []).reduce((s, r) => s + (r.sent_count || 0), 0);
  const emailsFailedThisMonth = (monthlyStats || []).reduce((s, r) => s + (r.failed_count || 0), 0);

  // ── 6. Google Workspace SMTP ──
  let smtpConnected = false;
  const smtpUser = (process.env.SMTP_USER || "").trim();
  const smtpPass = (process.env.SMTP_PASS || "").trim();
  const smtpPort = parseInt((process.env.SMTP_PORT || "587").trim(), 10);

  if (smtpUser && smtpPass) {
    try {
      await Promise.race([
        transporter.verify(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("SMTP verify timeout")), 5000)
        ),
      ]);
      smtpConnected = true;
    } catch { /* disconnected */ }
  }

  // ── 7. Resend ──
  const resendKey = process.env.RESEND_API_KEY || "";
  let resendDomainName: string | null = null;
  let resendDomainStatus = "unknown";

  if (resendKey) {
    try {
      const domainsRes = await fetch("https://api.resend.com/domains", {
        headers: { Authorization: `Bearer ${resendKey}` },
        cache: "no-store",
      });
      if (domainsRes.ok) {
        const domainsData = await domainsRes.json() as { data?: Array<{ name: string; status: string }> };
        const domain = domainsData.data?.[0];
        if (domain) {
          resendDomainName = domain.name;
          resendDomainStatus = domain.status;
        }
      }
    } catch { /* unavailable */ }
  }

  return NextResponse.json({
    fetched_at: new Date().toISOString(),
    supabase: {
      plan: "Free",
      project_ref: SUPABASE_REF,
      database: {
        used_bytes: diskUsed,
        total_bytes: diskTotal,
        percent: diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 100) : 0,
      },
      memory: {
        used_bytes: memUsed,
        total_bytes: memTotal,
        percent: memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : 0,
      },
      connections: { max: maxConnections },
      auth_users: {
        count: tableCounts.find((t) => t.name === "users")?.row_count || 0,
        limit: 50000,
      },
      storage: {
        bucket_count: bucketCount,
        file_count: fileCount,
        limit_bytes: 1 * 1024 * 1024 * 1024,
      },
      tables: tableCounts,
      total_rows: totalRows,
    },
    vercel: {
      plan: "Hobby",
      limits: {
        bandwidth_gb: 100,
        build_minutes_per_month: 6000,
        serverless_function_timeout_sec: 60,
        edge_requests: 1000000,
        projects: 200,
        deployments_per_day: 100,
      },
      usage: vercelUsage,
      has_token: !!vercelToken,
      dashboard_url: "https://vercel.com/dashboard/usage",
    },
    google_workspace: {
      smtp_user: smtpUser || "Not configured",
      smtp_port: smtpPort,
      connected: smtpConnected,
      daily_limit: 2000,
      sent_today: emailsSentToday,
      failed_today: emailsFailedToday,
      dashboard_url: "https://admin.google.com",
    },
    resend: {
      configured: !!resendKey,
      domain_name: resendDomainName,
      domain_status: resendDomainStatus,
      sent_today: emailsSentToday,
      failed_today: emailsFailedToday,
      sent_this_month: emailsSentThisMonth,
      failed_this_month: emailsFailedThisMonth,
      monthly_limit: 3000,
    },
  }, {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
