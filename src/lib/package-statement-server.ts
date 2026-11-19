import jsPDF from "jspdf";
import type { SupabaseClient } from "@supabase/supabase-js";
import { BRAND_DARK, BRAND_TEAL, addBrandHeader, addFooter, createPdfContext, formatDate } from "@/lib/pdf-utils";
import {
  buildPackageStatement,
  type PackageStatement,
  type StatementCancellation,
  type StatementPurchase,
  type StatementRedemption,
} from "@/lib/package-statement";
import { istDateString } from "@/lib/prepaid";

export interface PackageStatementData {
  purchaseId: string;
  party: { name: string; company: string | null; email: string | null };
  purchase: StatementPurchase;
  statement: PackageStatement;
}

// jsPDF's built-in Helvetica is Latin-1 only; anything outside it breaks line-width maths.
function sanitize(text: string): string {
  return text
    .replace(/₹/g, "Rs.")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[^\x00-\xFF]/g, "");
}

/** Read-only: everything recorded against one package, ready to render. */
export async function loadPackageStatement(
  admin: SupabaseClient,
  purchaseId: string,
): Promise<PackageStatementData | null> {
  const { data: p } = await admin
    .from("prepaid_purchases")
    .select(`
      id, credit_type, total_credits, credits_used, price_paid, purchased_at, expires_at,
      cancellation_window_hours, company_name,
      package:prepaid_packages(name),
      lead:leads(first_name, last_name, company, email),
      locations:prepaid_purchase_locations(location:locations(name)),
      redemptions:prepaid_redemptions(
        booking_id, credits_deducted, redeemed_at,
        booking:bookings(booking_number, location:locations!bookings_location_id_fkey(name))
      )
    `)
    .eq("id", purchaseId)
    .maybeSingle();
  if (!p) return null;

  const { data: events } = await admin
    .from("prepaid_cancellation_events")
    .select("booking_id, created_at, trigger, outcome, credits_restored, hours_before_start, window_hours, is_override, override_reason")
    .eq("purchase_id", purchaseId);

  /* eslint-disable @typescript-eslint/no-explicit-any -- joined rows are loosely typed by the client */
  const lead = p.lead as any;
  const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v);
  const leadRow = one(lead);
  const pkg = one(p.package as any);

  const purchase: StatementPurchase = {
    packageName: pkg?.name ?? "Prepaid package",
    creditType: p.credit_type,
    totalCredits: Number(p.total_credits),
    creditsUsed: Number(p.credits_used),
    pricePaid: Number(p.price_paid),
    purchasedAt: p.purchased_at,
    expiresAt: p.expires_at,
    cancellationWindowHours: p.cancellation_window_hours == null ? null : Number(p.cancellation_window_hours),
    locations: ((p.locations ?? []) as any[]).map((l) => one(l.location)?.name).filter(Boolean),
  };

  const redemptions: StatementRedemption[] = ((p.redemptions ?? []) as any[]).map((r) => {
    const booking = one(r.booking);
    return {
      bookingId: r.booking_id,
      bookingNumber: booking?.booking_number ?? "Booking",
      redeemedAt: r.redeemed_at,
      creditsDeducted: Number(r.credits_deducted),
      locationName: one(booking?.location)?.name ?? null,
    };
  });

  const cancellations: StatementCancellation[] = ((events ?? []) as any[]).map((e) => ({
    bookingId: e.booking_id,
    createdAt: e.created_at,
    trigger: e.trigger,
    outcome: e.outcome,
    creditsRestored: Number(e.credits_restored),
    hoursBeforeStart: Number(e.hours_before_start),
    windowHours: e.window_hours == null ? null : Number(e.window_hours),
    isOverride: !!e.is_override,
    overrideReason: e.override_reason,
  }));

  const personName = leadRow ? `${leadRow.first_name ?? ""} ${leadRow.last_name ?? ""}`.trim() : "";
  const company = p.company_name ?? leadRow?.company ?? null;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return {
    purchaseId,
    party: {
      name: p.company_name ? p.company_name : personName || "Customer",
      company: p.company_name ? null : company,
      email: leadRow?.email ?? null,
    },
    purchase,
    statement: buildPackageStatement(purchase, redemptions, cancellations),
  };
}

const num = (v: number) => String(Math.round(v * 100) / 100);
const shortDate = (d: string) =>
  new Date(d).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });

export function buildPackageStatementPdf(data: PackageStatementData): Buffer {
  const { purchase, statement, party } = data;
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const y0 = addBrandHeader(doc);
  const ctx = createPdfContext(doc, y0);
  let y = y0;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.setTextColor(...BRAND_TEAL);
  doc.text("PACKAGE STATEMENT OF ACCOUNT", 15, y);
  y += 7;
  doc.setFontSize(9);
  doc.setTextColor(...BRAND_DARK);
  doc.setFont("helvetica", "normal");
  doc.text(`Prepared on ${formatDate(new Date())}`, 15, y);
  y += 8;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text(sanitize(party.name), 15, y);
  y += 5;
  if (party.company) { doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.text(sanitize(party.company), 15, y); y += 5; }
  y += 2;

  const expired = purchase.expiresAt < istDateString();
  const facts: [string, string][] = [
    ["Package", purchase.packageName],
    ["Purchased", `${formatDate(purchase.purchasedAt)}, Rs. ${num(purchase.pricePaid)} including GST`],
    ["Valid at", purchase.locations.length ? purchase.locations.join(", ") : "All locations"],
    ["Expires", `${formatDate(purchase.expiresAt)}${expired ? " (expired)" : ""}`],
    ["Free cancellation", purchase.cancellationWindowHours === null
      ? "Credits are not restored on cancellation"
      : `Up to ${num(purchase.cancellationWindowHours)} hrs before start`],
  ];
  doc.setFontSize(9);
  for (const [k, v] of facts) {
    doc.setFont("helvetica", "bold");
    doc.text(k, 15, y);
    doc.setFont("helvetica", "normal");
    const lines = doc.splitTextToSize(sanitize(v), 140) as string[];
    doc.text(lines, 55, y);
    y += lines.length * 4.5 + 0.5;
  }
  y += 4;
  ctx.y = y;

  const X = { date: 15, entry: 38, change: 160, balance: 194 };
  const header = () => {
    doc.setFillColor(...BRAND_TEAL);
    doc.rect(15, ctx.y - 4.5, 180, 7, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(255, 255, 255);
    doc.text("Date", X.date + 1, ctx.y);
    doc.text("Entry", X.entry, ctx.y);
    doc.text(`Credits (${statement.unitLabel})`, X.change, ctx.y, { align: "right" });
    doc.text("Balance", X.balance, ctx.y, { align: "right" });
    ctx.y += 6;
  };

  header();
  for (const r of statement.rows) {
    const detailLines = doc.splitTextToSize(sanitize(r.detail), 110) as string[];
    const h = 4.5 + detailLines.length * 3.6 + 2;
    const pagesBefore = doc.getNumberOfPages();
    ctx.checkPageBreak(h);
    if (doc.getNumberOfPages() !== pagesBefore) header();

    const tag = r.tag === "restored" ? "[Restored] " : r.tag === "forfeited" ? "[Not restored] " : r.tag === "override" ? "[Override] " : "";
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(...BRAND_DARK);
    doc.text(shortDate(r.date), X.date + 1, ctx.y);
    doc.setFont("helvetica", "bold");
    doc.text(sanitize(tag + r.entry), X.entry, ctx.y);
    doc.setFont("helvetica", "normal");
    doc.text(r.change === 0 ? "0" : r.change > 0 ? `+${num(r.change)}` : `-${num(Math.abs(r.change))}`, X.change, ctx.y, { align: "right" });
    doc.text(num(r.balance), X.balance, ctx.y, { align: "right" });
    ctx.y += 4;
    doc.setFontSize(7.5);
    doc.setTextColor(95, 95, 95);
    doc.text(detailLines, X.entry, ctx.y);
    ctx.y += detailLines.length * 3.6 + 1;
    doc.setDrawColor(225, 225, 225);
    doc.line(15, ctx.y - 1.5, 195, ctx.y - 1.5);
    ctx.y += 1.5;
  }

  ctx.checkPageBreak(14);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(...BRAND_DARK);
  doc.text(
    `Balance: ${num(statement.balance)} of ${num(purchase.totalCredits)} ${statement.unitLabel}${expired ? ", package expired" : `, valid till ${formatDate(purchase.expiresAt)}`}`,
    15,
    ctx.y + 4,
  );

  addFooter(doc);
  return Buffer.from(doc.output("arraybuffer"));
}
