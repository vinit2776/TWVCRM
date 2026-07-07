import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { unifiRequest, siteConfigFromLocation } from "@/lib/unifi";

/**
 * GET /api/cron/unifi-ap-health
 *
 * Polls every UniFi-managed location's access points and emails admins/
 * IT staff when an AP transitions from online -> offline. Runs every
 * 15 minutes (see vercel.json) since AP outages are time-sensitive.
 *
 * State is tracked in unifi_ap_alert_state so a still-down AP only
 * triggers one alert per outage, not one per cron tick.
 */

interface UnifiDevice {
  mac?: string;
  name?: string;
  state?: number;
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  const { data: locations, error: locErr } = await admin
    .from("locations")
    .select("id, name, unifi_console_id, unifi_site_id, wifi_voucher_mode")
    .not("unifi_site_id", "is", null);

  if (locErr) {
    console.error("[unifi-ap-health] location fetch error:", locErr);
    return NextResponse.json({ error: locErr.message }, { status: 500 });
  }

  const targets = (locations ?? []).filter(
    (l) => l.wifi_voucher_mode === "unifi_api" || Boolean(l.unifi_console_id)
  );

  if (targets.length === 0) {
    return NextResponse.json({ message: "No UniFi-managed locations", checked: 0, transitions: 0 });
  }

  const newlyDown: { location: string; ap: string; mac: string }[] = [];
  const recovered: { location: string; ap: string; mac: string }[] = [];
  let checked = 0;

  for (const loc of targets) {
    let devices: UnifiDevice[];
    try {
      devices = await unifiRequest<UnifiDevice[]>("/stat/device", {}, siteConfigFromLocation(loc));
    } catch (err) {
      console.error(`[unifi-ap-health] failed to fetch devices for ${loc.name}:`, err);
      continue;
    }

    const { data: priorStates } = await admin
      .from("unifi_ap_alert_state")
      .select("mac, last_status")
      .eq("location_id", loc.id);
    const priorByMac = new Map((priorStates ?? []).map((s) => [s.mac, s.last_status]));

    const now = new Date().toISOString();

    for (const d of devices) {
      if (!d.mac) continue;
      checked++;
      const status = d.state === 1 ? "online" : "offline";
      const prior = priorByMac.get(d.mac);

      if (prior === "online" && status === "offline") {
        newlyDown.push({ location: loc.name, ap: d.name || d.mac, mac: d.mac });
      } else if (prior === "offline" && status === "online") {
        recovered.push({ location: loc.name, ap: d.name || d.mac, mac: d.mac });
      }

      await admin.from("unifi_ap_alert_state").upsert(
        {
          location_id: loc.id,
          mac: d.mac,
          ap_name: d.name || null,
          last_status: status,
          down_since: status === "offline" ? (prior === "offline" ? undefined : now) : null,
          last_checked_at: now,
        },
        { onConflict: "location_id,mac" }
      );
    }
  }

  if (newlyDown.length > 0 || recovered.length > 0) {
    try {
      await sendApAlertEmail(newlyDown, recovered);
    } catch (err) {
      console.error("[unifi-ap-health] email failed:", err);
    }
  }

  return NextResponse.json({
    checked,
    newly_down: newlyDown.length,
    recovered: recovered.length,
  });
}

async function sendApAlertEmail(
  newlyDown: { location: string; ap: string; mac: string }[],
  recovered: { location: string; ap: string; mac: string }[]
) {
  const downRows = newlyDown
    .map(
      (d) => `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${d.location}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${d.ap}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-family:monospace;font-size:12px;">${d.mac}</td>
      </tr>`
    )
    .join("");

  const recoveredRows = recovered
    .map(
      (d) => `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${d.location}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${d.ap}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-family:monospace;font-size:12px;">${d.mac}</td>
      </tr>`
    )
    .join("");

  const subjectParts: string[] = [];
  if (newlyDown.length > 0) subjectParts.push(`${newlyDown.length} AP(s) down`);
  if (recovered.length > 0) subjectParts.push(`${recovered.length} recovered`);

  await resend.emails.send({
    from: EMAIL_FROM,
    replyTo: EMAIL_REPLY_TO,
    to: ["admin@theworkvilla.com"],
    subject: `Network Alert — ${subjectParts.join(", ")}`,
    html: `
      <div style="font-family:sans-serif;max-width:640px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <div style="background:${newlyDown.length > 0 ? "#dc2626" : "#16a34a"};padding:20px 32px;">
          <h1 style="color:white;margin:0;font-size:20px;">Network Alert</h1>
        </div>
        <div style="padding:28px 32px;">
          ${
            newlyDown.length > 0
              ? `<p style="color:#333;font-size:14px;"><strong>${newlyDown.length} access point(s) went offline:</strong></p>
                 <table style="width:100%;border-collapse:collapse;margin:8px 0 20px;font-size:13px;">
                   <tr style="background:#fef2f2;">
                     <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #fecaca;color:#991b1b;font-size:11px;">Location</th>
                     <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #fecaca;color:#991b1b;font-size:11px;">AP</th>
                     <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #fecaca;color:#991b1b;font-size:11px;">MAC</th>
                   </tr>
                   ${downRows}
                 </table>`
              : ""
          }
          ${
            recovered.length > 0
              ? `<p style="color:#333;font-size:14px;"><strong>${recovered.length} access point(s) recovered:</strong></p>
                 <table style="width:100%;border-collapse:collapse;margin:8px 0;font-size:13px;">
                   <tr style="background:#f0fdf4;">
                     <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #bbf7d0;color:#166534;font-size:11px;">Location</th>
                     <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #bbf7d0;color:#166534;font-size:11px;">AP</th>
                     <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #bbf7d0;color:#166534;font-size:11px;">MAC</th>
                   </tr>
                   ${recoveredRows}
                 </table>`
              : ""
          }
          <p style="color:#666;font-size:12px;">Check the Network &gt; Infrastructure tab for reboot/reprovision options.</p>
        </div>
        <div style="background:#015E65;padding:12px 32px;text-align:center;">
          <p style="color:#fff;margin:0;font-size:10px;">SREE DESIGN INFRASTRUCTURE PVT LTD | The WorkVilla</p>
        </div>
      </div>
    `,
  });
}
