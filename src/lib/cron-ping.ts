/**
 * Notify the cron health tracker on job completion.
 * Call at the end of every cron route handler.
 *
 * Silently swallows errors — a failed ping must never crash a cron job.
 */
export async function pingCronHealth(
  job: string,
  status: "ok" | "error" = "ok",
  details?: Record<string, unknown>
) {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.APP_URL;
    if (!baseUrl || !process.env.CRON_SECRET) return;

    await fetch(`${baseUrl}/api/health/cron-ping`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.CRON_SECRET}`,
      },
      body: JSON.stringify({ job, status, details }),
    });
  } catch {
    // silent — cron health ping must never block the main job
  }
}
