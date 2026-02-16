import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { parseVoucherPDF } from "@/lib/voucher-pdf-parser";
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

  const offset = (page - 1) * limit;

  let query = supabase
    .from("voucher_repository")
    .select("*", { count: "exact" });

  if (status) query = query.eq("status", status);
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

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    if (!file.name.toLowerCase().endsWith(".pdf")) {
      return NextResponse.json({ error: "Only PDF files are accepted" }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

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
    }));

    const { data, error } = await supabase
      .from("voucher_repository")
      .insert(rows)
      .select("*");

    if (error) {
      // Handle duplicate code errors
      if (error.code === "23505") {
        return NextResponse.json(
          { error: "Some voucher codes already exist in the repository" },
          { status: 409 }
        );
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (data && data.length > 0) {
      logAudit(supabase, {
        entityType: "voucher",
        entityId: data[0].id,
        action: "create",
        performedBy: currentUser.id,
        changes: { count: { old: null, new: data.length }, source: { old: null, new: "pdf" } },
      });
    }

    return NextResponse.json(
      {
        message: `${data?.length || 0} vouchers uploaded from PDF`,
        count: data?.length || 0,
        detected_validity: parsed.detected_validity,
        applied_validity: validityDays,
        parse_warnings: parsed.errors,
      },
      { status: 201 }
    );
  }

  // ===== Legacy JSON Upload =====
  const body = await request.json();
  const { vouchers, validity_days: bodyValidity } = body as {
    vouchers: Array<{ voucher_code: string; metadata?: Record<string, unknown> }>;
    validity_days?: number;
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
  }));

  const { data, error } = await supabase
    .from("voucher_repository")
    .insert(rows)
    .select("*");

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json(
        { error: "Some voucher codes already exist in the repository" },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (data && data.length > 0) {
    logAudit(supabase, {
      entityType: "voucher",
      entityId: data[0].id,
      action: "create",
      performedBy: currentUser.id,
      changes: { count: { old: null, new: data.length } },
    });
  }

  return NextResponse.json(
    { message: `${data?.length || 0} vouchers uploaded`, count: data?.length || 0 },
    { status: 201 }
  );
}
