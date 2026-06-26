import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const patchConsumptionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("void"),
    reason: z.string().min(5, "Reason must be at least 5 characters"),
  }),
  z.object({
    action: z.literal("adjust"),
    item_id: z.string().uuid(),
    reason: z.string().min(5, "Reason must be at least 5 characters"),
    new_quantity: z.number().min(0),
  }),
  z.object({
    action: z.literal("relog"),
    reason: z.string().min(5, "Reason must be at least 5 characters"),
    new_items: z
      .array(
        z.object({
          item_id: z.string().uuid().optional(),
          item_name: z.string().min(1),
          unit: z.string().min(1),
          quantity_consumed: z.number().positive(),
          notes: z.string().optional(),
        })
      )
      .min(1),
  }),
]);

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const { data: log, error } = await supabase
    .from("consumption_logs")
    .select(
      `*, consumption_log_items(*), consumption_corrections!consumption_corrections_consumption_log_id_fkey(*, corrector:users!consumption_corrections_corrected_by_fkey(id, full_name)), logger:users!consumption_logs_logged_by_fkey(id, full_name), locations(id, name)`
    )
    .eq("id", id)
    .single();

  if (error || !log) return NextResponse.json({ error: "Consumption log not found" }, { status: 404 });

  return NextResponse.json({ data: log });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  if (!["admin", "manager", "office_admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const { data: log, error: fetchError } = await supabase
    .from("consumption_logs")
    .select("*, consumption_log_items(*)")
    .eq("id", id)
    .single();

  if (fetchError || !log) return NextResponse.json({ error: "Consumption log not found" }, { status: 404 });

  if (log.status === "voided") {
    return NextResponse.json({ error: "Cannot modify a voided consumption log" }, { status: 422 });
  }

  const body = await request.json();
  const parsed = patchConsumptionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const { action } = parsed.data;
  const logItems = log.consumption_log_items as Array<{
    id: string;
    item_id: string | null;
    item_name: string;
    unit: string;
    quantity_consumed: number;
  }>;

  switch (action) {
    // ── VOID ────────────────────────────────────────────────────────────────
    case "void": {
      // Restore stock for each item
      for (const item of logItems) {
        if (!item.item_id) continue;
        const { error: rpcError } = await supabase.rpc("upsert_location_stock", {
          p_location_id: log.location_id,
          p_item_id: item.item_id,
          p_quantity_delta: item.quantity_consumed,
        });
        if (rpcError) {
          console.error(`Failed to restore stock for ${item.item_name}:`, rpcError.message);
        }
      }

      // Set log as voided
      const { error: updateError } = await supabase
        .from("consumption_logs")
        .update({ status: "voided" })
        .eq("id", id);

      if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

      // Insert correction records
      const corrections = logItems.map((item) => ({
        consumption_log_id: id,
        consumption_log_item_id: item.id,
        correction_type: "void",
        reason: parsed.data.reason,
        original_quantity: item.quantity_consumed,
        new_quantity: 0,
        corrected_by: dbUser.id,
      }));

      const { error: correctionError } = await supabase
        .from("consumption_corrections")
        .insert(corrections);
      if (correctionError) {
        console.error("Failed to record void corrections:", correctionError.message);
        // Void and stock restore already committed — can't roll back here.
        // Return success with a warning so the caller knows the audit trail needs a follow-up.
        return NextResponse.json({
          data: { id, status: "voided" },
          warning: "Void recorded but correction audit trail could not be written. Contact support.",
        });
      }

      await logAudit(supabase, {
        entityType: "consumption_log",
        entityId: id,
        action: "update",
        performedBy: dbUser.id,
        changes: {
          status: { old: log.status, new: "voided" },
          reason: { old: null, new: parsed.data.reason },
        },
      });

      return NextResponse.json({ data: { id, status: "voided" } });
    }

    // ── ADJUST ──────────────────────────────────────────────────────────────
    case "adjust": {
      const adjustData = parsed.data as { action: "adjust"; item_id: string; reason: string; new_quantity: number };
      const targetItem = logItems.find((i) => i.id === adjustData.item_id);
      if (!targetItem) {
        return NextResponse.json({ error: "Consumption log item not found" }, { status: 404 });
      }

      const oldQty = targetItem.quantity_consumed;
      const newQty = adjustData.new_quantity;
      const delta = oldQty - newQty; // positive means restoring stock

      // Update item quantity
      const { error: updateItemError } = await supabase
        .from("consumption_log_items")
        .update({ quantity_consumed: newQty })
        .eq("id", adjustData.item_id);

      if (updateItemError) return NextResponse.json({ error: updateItemError.message }, { status: 500 });

      // Adjust stock
      if (targetItem.item_id && delta !== 0) {
        const { error: rpcError } = await supabase.rpc("upsert_location_stock", {
          p_location_id: log.location_id,
          p_item_id: targetItem.item_id,
          p_quantity_delta: delta,
        });
        if (rpcError) {
          return NextResponse.json({ error: `Failed to adjust stock: ${rpcError.message}` }, { status: 500 });
        }
      }

      // Insert correction record
      await supabase.from("consumption_corrections").insert({
        consumption_log_id: id,
        consumption_log_item_id: adjustData.item_id,
        correction_type: "adjust",
        reason: adjustData.reason,
        original_quantity: oldQty,
        new_quantity: newQty,
        corrected_by: dbUser.id,
      });

      await logAudit(supabase, {
        entityType: "consumption_log",
        entityId: id,
        action: "update",
        performedBy: dbUser.id,
        changes: {
          item_adjusted: { old: oldQty, new: newQty },
          item_id: { old: null, new: adjustData.item_id },
          reason: { old: null, new: adjustData.reason },
        },
      });

      return NextResponse.json({ data: { id, item_id: parsed.data.item_id, old_quantity: oldQty, new_quantity: newQty } });
    }

    // ── RELOG ────────────────────────────────────────────────────────────────
    case "relog": {
      // Step 1: Void the original log (restore stock)
      for (const item of logItems) {
        if (!item.item_id) continue;
        const { error: rpcError } = await supabase.rpc("upsert_location_stock", {
          p_location_id: log.location_id,
          p_item_id: item.item_id,
          p_quantity_delta: item.quantity_consumed,
        });
        if (rpcError) {
          console.error(`Failed to restore stock for ${item.item_name}:`, rpcError.message);
        }
      }

      const { error: voidError } = await supabase
        .from("consumption_logs")
        .update({ status: "voided" })
        .eq("id", id);

      if (voidError) return NextResponse.json({ error: voidError.message }, { status: 500 });

      // Step 2: Validate new items stock availability
      for (const item of parsed.data.new_items) {
        if (!item.item_id) continue;
        const { data: stock } = await supabase
          .from("location_stock")
          .select("quantity_on_hand")
          .eq("location_id", log.location_id)
          .eq("item_id", item.item_id)
          .single();

        const onHand = stock?.quantity_on_hand ?? 0;
        if (item.quantity_consumed > Number(onHand)) {
          return NextResponse.json({
            error: `${item.item_name}: quantity (${item.quantity_consumed}) exceeds available stock (${onHand})`,
          }, { status: 422 });
        }
      }

      // Step 3: Create new consumption log
      const { data: newLog, error: newLogError } = await supabase
        .from("consumption_logs")
        .insert({
          location_id: log.location_id,
          notes: `Relogged from ${id}`,
          logged_by: dbUser.id,
          status: "active",
        })
        .select("id")
        .single();

      if (newLogError) return NextResponse.json({ error: newLogError.message }, { status: 500 });

      // Insert new items
      const newItems = parsed.data.new_items.map((item) => ({
        consumption_log_id: newLog.id,
        item_id: item.item_id ?? null,
        item_name: item.item_name,
        unit: item.unit,
        quantity_consumed: item.quantity_consumed,
        notes: item.notes ?? null,
      }));

      const { error: newItemsError } = await supabase.from("consumption_log_items").insert(newItems);
      if (newItemsError) return NextResponse.json({ error: newItemsError.message }, { status: 500 });

      // Deduct stock for new items
      for (const item of parsed.data.new_items) {
        if (!item.item_id) continue;
        const { error: rpcError } = await supabase.rpc("upsert_location_stock", {
          p_location_id: log.location_id,
          p_item_id: item.item_id,
          p_quantity_delta: -item.quantity_consumed,
        });
        if (rpcError) {
          console.error(`Failed to deduct stock for ${item.item_name}:`, rpcError.message);
        }
      }

      // Insert correction records for voided items
      const voidCorrections = logItems.map((item) => ({
        consumption_log_id: id,
        consumption_log_item_id: item.id,
        correction_type: "relog",
        reason: parsed.data.reason,
        original_quantity: item.quantity_consumed,
        new_quantity: 0,
        new_consumption_log_id: newLog.id,
        corrected_by: dbUser.id,
      }));

      const { error: relogCorrectionError } = await supabase
        .from("consumption_corrections")
        .insert(voidCorrections);
      if (relogCorrectionError) {
        console.error("Failed to record relog corrections:", relogCorrectionError.message);
      }

      await logAudit(supabase, {
        entityType: "consumption_log",
        entityId: id,
        action: "update",
        performedBy: dbUser.id,
        changes: {
          status: { old: log.status, new: "voided" },
          reason: { old: null, new: parsed.data.reason },
          new_log_id: { old: null, new: newLog.id },
        },
      });

      await logAudit(supabase, {
        entityType: "consumption_log",
        entityId: newLog.id,
        action: "create",
        performedBy: dbUser.id,
        changes: {
          relogged_from: { old: null, new: id },
          item_count: { old: null, new: parsed.data.new_items.length },
        },
      });

      return NextResponse.json({
        data: {
          voided_log_id: id,
          new_log_id: newLog.id,
        },
      });
    }
  }
}
