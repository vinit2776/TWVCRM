import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SUPABASE_REF = SUPABASE_URL.replace("https://", "").replace(".supabase.co", "");

// Tables to count rows for
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

/**
 * Parse a specific metric value from Prometheus text format.
 * Supports label filtering (e.g., { mountpoint: "/data" }).
 */
function parsePrometheusMetric(
  text: string,
  metricName: string,
  labels?: Record<string, string>
): number | null {
  const lines = text.split("\n");

  for (const line of lines) {
    if (line.startsWith("#") || !line.startsWith(metricName)) continue;

    // Check label match if specified
    if (labels) {
      let allMatch = true;
      for (const [key, value] of Object.entries(labels)) {
        if (!line.includes(`${key}="${value}"`)) {
          allMatch = false;
          break;
        }
      }
      if (!allMatch) continue;
    }

    // Extract numeric value (last space-separated token)
    const parts = line.split(/\s+/);
    const val = parseFloat(parts[parts.length - 1]);
    if (!isNaN(val)) return val;
  }

  return null;
}

/**
 * GET /api/admin/infrastructure
 * Returns live infrastructure metrics for the monitoring dashboard.
 * Admin-only.
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Verify admin role
  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || dbUser.role !== "admin") {
    return NextResponse.json(
      { error: "Only admins can access infrastructure data" },
      { status: 403 }
    );
  }

  // ── 1. Fetch Supabase Prometheus Metrics ──
  let metricsText = "";
  try {
    const metricsRes = await fetch(
      `${SUPABASE_URL}/customer/v1/privileged/metrics`,
      {
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(`service_role:${SERVICE_ROLE_KEY}`).toString("base64"),
        },
        cache: "no-store",
      }
    );
    if (metricsRes.ok) {
      metricsText = await metricsRes.text();
    }
  } catch {
    // Metrics endpoint unavailable — continue with defaults
  }

  // Parse key metrics
  const diskTotal =
    parsePrometheusMetric(metricsText, "node_filesystem_size_bytes", {
      mountpoint: "/data",
    }) || 0;
  const diskAvailable =
    parsePrometheusMetric(metricsText, "node_filesystem_avail_bytes", {
      mountpoint: "/data",
    }) || 0;
  const diskUsed = diskTotal - diskAvailable;

  const memTotal =
    parsePrometheusMetric(metricsText, "node_memory_MemTotal_bytes") || 0;
  const memAvailable =
    parsePrometheusMetric(metricsText, "node_memory_MemAvailable_bytes") || 0;
  const memUsed = memTotal - memAvailable;

  const maxConnections =
    parsePrometheusMetric(
      metricsText,
      "pgbouncer_config_max_client_connections"
    ) || 200;

  // ── 2. Fetch Row Counts ──
  const tableCounts: Array<{ name: string; row_count: number }> = [];

  const countPromises = TABLES.map(async (table) => {
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/${table}?select=id&limit=1`,
        {
          method: "GET",
          headers: {
            apikey: SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
            Prefer: "count=exact",
          },
          cache: "no-store",
        }
      );
      const range = res.headers.get("content-range");
      const count = range ? parseInt(range.split("/")[1] || "0", 10) : 0;
      return { name: table, row_count: isNaN(count) ? 0 : count };
    } catch {
      return { name: table, row_count: 0 };
    }
  });

  const countResults = await Promise.all(countPromises);
  tableCounts.push(...countResults);

  // Sort by row count descending
  tableCounts.sort((a, b) => b.row_count - a.row_count);

  const totalRows = tableCounts.reduce((sum, t) => sum + t.row_count, 0);

  // ── 3. Fetch Storage Info ──
  let bucketCount = 0;
  let fileCount = 0;

  try {
    const bucketsRes = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      },
      cache: "no-store",
    });

    if (bucketsRes.ok) {
      const buckets = await bucketsRes.json();
      bucketCount = Array.isArray(buckets) ? buckets.length : 0;

      // Count files in each bucket
      for (const bucket of buckets) {
        try {
          const listRes = await fetch(
            `${SUPABASE_URL}/storage/v1/object/list/${bucket.id}`,
            {
              method: "POST",
              headers: {
                apikey: SERVICE_ROLE_KEY,
                Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ limit: 1000, offset: 0 }),
              cache: "no-store",
            }
          );
          if (listRes.ok) {
            const files = await listRes.json();
            fileCount += Array.isArray(files) ? files.length : 0;
          }
        } catch {
          // Skip bucket listing errors
        }
      }
    }
  } catch {
    // Storage API unavailable
  }

  // ── 4. Auth Users Count ──
  const usersRow = tableCounts.find((t) => t.name === "users");
  const authUserCount = usersRow?.row_count || 0;

  // ── 5. Fetch Resend Email Stats ──
  let emailsSentToday = 0;
  let emailsSentThisMonth = 0;
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (RESEND_API_KEY && RESEND_API_KEY !== "re_placeholder") {
    try {
      const resendRes = await fetch("https://api.resend.com/emails", {
        headers: { Authorization: `Bearer ${RESEND_API_KEY}` },
        cache: "no-store",
      });
      if (resendRes.ok) {
        const resendData = await resendRes.json();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const emails: any[] = resendData.data || [];
        const now = new Date();
        const todayStr = now.toISOString().split("T")[0];
        const monthStr = todayStr.substring(0, 7); // "2025-06"
        emailsSentToday = emails.filter((e) => e.created_at?.startsWith(todayStr)).length;
        emailsSentThisMonth = emails.filter((e) => e.created_at?.startsWith(monthStr)).length;
      }
    } catch {
      // Resend API unavailable — continue with zero counts
    }
  }

  // ── Build Response ──
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
      connections: {
        max: maxConnections,
      },
      auth_users: {
        count: authUserCount,
        limit: 50000,
      },
      storage: {
        bucket_count: bucketCount,
        file_count: fileCount,
        limit_bytes: 1 * 1024 * 1024 * 1024, // 1 GB free
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
      dashboard_url: "https://vercel.com/dashboard/usage",
    },
    resend: {
      plan: "Free",
      limits: {
        daily_emails: 100,
        monthly_emails: 3000,
      },
      usage: {
        sent_today: emailsSentToday,
        sent_this_month: emailsSentThisMonth,
      },
      dashboard_url: "https://resend.com/overview",
    },
  }, {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
