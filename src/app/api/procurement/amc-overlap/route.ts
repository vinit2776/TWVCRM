import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { poIdsCoveringAsset } from "@/lib/procurement/amc-assets";
import { datesOverlap, type AmcConflict } from "@/lib/procurement/amc-overlap";

// Read-only: lists the live AMCs (POs and requests not yet ordered) that already cover an asset
// during the given dates. Used to warn, never to block.
const query = z.object({
  asset_ids: z.string().min(1),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  exclude_pr: z.string().uuid().optional(),
});
const MAX_ASSETS = 20;
const uuid = z.string().uuid();

// Requests that still stand as a commitment but have no PO yet. Fully ordered ones show up as POs.
const OPEN_REQUEST_STATUSES = ["submitted", "approved", "partially_ordered"];

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const { start, end, exclude_pr } = parsed.data;
  const assetIds = parsed.data.asset_ids.split(",").filter((id) => uuid.safeParse(id).success).slice(0, MAX_ASSETS);

  const conflicts: Record<string, AmcConflict[]> = {};
  await Promise.all(
    assetIds.map(async (assetId) => {
      const found: AmcConflict[] = [];

      const poIds = await poIdsCoveringAsset(supabase, assetId);
      if (poIds.length > 0) {
        const { data: pos } = await supabase
          .from("purchase_orders")
          .select("id, po_number, amc_start_date, amc_end_date, amc_terminated_at, procurement_vendors(name)")
          .in("id", poIds)
          .eq("po_type", "service");
        for (const po of pos ?? []) {
          if (po.amc_terminated_at || !po.amc_start_date || !po.amc_end_date) continue;
          if (!datesOverlap(start, end, po.amc_start_date, po.amc_end_date)) continue;
          const vendor = Array.isArray(po.procurement_vendors) ? po.procurement_vendors[0] : po.procurement_vendors;
          found.push({ kind: "po", id: po.id, number: po.po_number, vendor: vendor?.name ?? null, start: po.amc_start_date, end: po.amc_end_date });
        }
      }

      const { data: lines } = await supabase
        .from("purchase_request_items")
        .select("purchase_requests!inner(id, pr_number, status, department, amc_start_date, amc_end_date)")
        .eq("linked_asset_id", assetId);
      for (const line of lines ?? []) {
        const pr = Array.isArray(line.purchase_requests) ? line.purchase_requests[0] : line.purchase_requests;
        if (!pr || pr.department !== "amc" || !OPEN_REQUEST_STATUSES.includes(pr.status)) continue;
        if (pr.id === exclude_pr || !pr.amc_start_date || !pr.amc_end_date) continue;
        if (!datesOverlap(start, end, pr.amc_start_date, pr.amc_end_date)) continue;
        if (!found.some((c) => c.kind === "request" && c.id === pr.id)) {
          found.push({ kind: "request", id: pr.id, number: pr.pr_number, vendor: null, start: pr.amc_start_date, end: pr.amc_end_date });
        }
      }

      if (found.length > 0) conflicts[assetId] = found;
    }),
  );

  return NextResponse.json({ conflicts });
}
