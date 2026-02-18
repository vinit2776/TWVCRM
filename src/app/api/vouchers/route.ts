import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { maskVoucherCode } from "@/lib/utils";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "50");
  const status = searchParams.get("status");
  const validityDays = searchParams.get("validity_days");
  const locationId = searchParams.get("location_id");

  const offset = (page - 1) * limit;

  let query = supabase
    .from("voucher_repository")
    .select("*, location:locations!voucher_repository_location_id_fkey(id, name, code)", { count: "exact" });

  if (status) query = query.eq("status", status);
  if (locationId) query = query.eq("location_id", locationId);
  if (validityDays) {
    if (validityDays === "unclassified") {
      query = query.is("validity_days", null);
    } else {
      query = query.eq("validity_days", parseInt(validityDays));
    }
  }
  query = query.order("uploaded_at", { ascending: false }).range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Mask codes for available vouchers
  const maskedData = (data || []).map((v) => ({
    ...v,
    voucher_code: v.status === "available" ? maskVoucherCode(v.voucher_code) : v.voucher_code,
  }));

  return NextResponse.json({
    data: maskedData,
    pagination: { page, limit, total: count || 0, totalPages: Math.ceil((count || 0) / limit) },
  });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Check if current user is admin
  const { data: currentUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!currentUser || currentUser.role !== "admin") {
    return NextResponse.json({ error: "Only admins can upload vouchers" }, { status: 403 });
  }

  const contentType = request.headers.get("content-type") || "";

  // ===== PDF Upload (multipart/form-data) =====
  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const validityOverride = formData.get("validity_days") as string | null;
    const uploadLocationId = formData.get("location_id") as string | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    if (!file.name.toLowerCase().endsWith(".pdf")) {
      return NextResponse.json({ error: "Only PDF files are accepted" }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Dynamic import — keeps pdfjs-dist out of the initial bundle
    const { parseVoucherPDF } = await import("@/lib/voucher-pdf-parser");
    const parsed = await parseVoucherPDF(buffer);

    if (parsed.vouchers.length === 0) {
      return NextResponse.json(
        {
          error: "No voucher codes found in PDF",
          parse_warnings: parsed.errors,
        },
        { status: 400 }
      );
    }

    const validityDays = validityOverride
      ? parseInt(validityOverride)
      : parsed.detected_validity;

    const rows = parsed.vouchers.map((v) => ({
      voucher_code: v.voucher_code,
      status: "available" as const,
      validity_days: validityDays,
      metadata: v.metadata,
      uploaded_by: currentUser.id,
      location_id: uploadLocationId || null,
    }));

    // Use upsert with ignoreDuplicates to skip existing codes gracefully
    const { data, error } = await supabase
      .from("voucher_repository")
      .upsert(rows, { onConflict: "voucher_code", ignoreDuplicates: true })
      .select("*");

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const insertedCount = data?.length || 0;
    const skippedDuplicates = rows.length - insertedCount;

    if (insertedCount > 0) {
      logAudit(supabase, {
        entityType: "voucher",
        entityId: data![0].id,
        action: "create",
        performedBy: currentUser.id,
        changes: { count: { old: null, new: insertedCount }, source: { old: null, new: "pdf" } },
      });
    }

    return NextResponse.json(
      {
        message: `${insertedCount} vouchers uploaded from PDF`,
        count: insertedCount,
        skipped_duplicates: skippedDuplicates,
        detected_validity: parsed.detected_validity,
        applied_validity: validityDays,
        parse_warnings: parsed.errors,
      },
      { status: 201 }
    );
  }

  // ===== Legacy JSON Upload =====
  const body = await request.json();
  const { vouchers, validity_days: bodyValidity, location_id: bodyLocationId } = body as {
    vouchers: Array<{ voucher_code: string; metadata?: Record<string, unknown> }>;
    validity_days?: number;
    location_id?: string;
  };

  if (!vouchers || !Array.isArray(vouchers) || vouchers.length === 0) {
    return NextResponse.json(
      { error: "A non-empty vouchers array is required" },
      { status: 400 }
    );
  }

  const rows = vouchers.map((v) => ({
    voucher_code: v.voucher_code,
    status: "available" as const,
    validity_days: bodyValidity ?? null,
    metadata: v.metadata || {},
    uploaded_by: currentUser.id,
    location_id: bodyLocationId || null,
  }));

  // Use upsert with ignoreDuplicates to skip existing codes gracefully
  const { data, error } = await supabase
    .from("voucher_repository")
    .upsert(rows, { onConflict: "voucher_code", ignoreDuplicates: true })
    .select("*");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const insertedCount = data?.length || 0;
  const skippedDuplicates = rows.length - insertedCount;

  if (insertedCount > 0) {
    logAudit(supabase, {
      entityType: "voucher",
      entityId: data![0].id,
      action: "create",
      performedBy: currentUser.id,
      changes: { count: { old: null, new: insertedCount } },
    });
  }

  return NextResponse.json(
    {
      message: `${insertedCount} vouchers uploaded`,
      count: insertedCount,
      skipped_duplicates: skippedDuplicates,
    },
    { status: 201 }
  );
}
