import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { importLeadSchema } from "@/lib/validations";
import { logAudit } from "@/lib/audit";
import { transformZohoRow } from "@/lib/zoho-field-mapping";
import Papa from "papaparse";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const BATCH_SIZE = 100;

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const adminSupabase = await createAdminClient();

  // Get the user's internal ID and check admin role
  const { data: dbUser } = await adminSupabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || (dbUser.role !== "admin" && dbUser.role !== "manager")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Parse multipart form data
  const formData = await request.formData();
  const file = formData.get("file") as File | null;

  if (!file) {
    return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
  }

  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: "File too large. Maximum 10MB." },
      { status: 400 }
    );
  }

  if (!file.name.endsWith(".csv")) {
    return NextResponse.json(
      { error: "Only CSV files are supported" },
      { status: 400 }
    );
  }

  // Read and parse CSV
  const text = await file.text();
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  if (parsed.errors.length > 0 && parsed.data.length === 0) {
    return NextResponse.json(
      { error: "Failed to parse CSV: " + parsed.errors[0].message },
      { status: 400 }
    );
  }

  const rows = parsed.data;
  if (rows.length === 0) {
    return NextResponse.json(
      { error: "CSV file is empty — no data rows found" },
      { status: 400 }
    );
  }

  // Transform rows
  const validLeads: Array<Record<string, unknown>> = [];
  const errors: Array<{ row: number; message: string }> = [];
  const warnings: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 2; // +2 because row 1 is headers, and humans count from 1
    const result = transformZohoRow(rows[i], rowNum);

    if (result.error) {
      errors.push({ row: rowNum, message: result.error });
      continue;
    }

    if (result.warnings.length > 0) {
      warnings.push(...result.warnings);
    }

    if (!result.lead) continue;

    // Validate with import schema
    const validation = importLeadSchema.safeParse(result.lead);
    if (!validation.success) {
      const msg = validation.error.issues.map((e) => e.message).join(", ");
      errors.push({ row: rowNum, message: msg });
      continue;
    }

    const leadData = validation.data;

    validLeads.push({
      ...leadData,
      // Remove empty strings for optional fields to avoid DB issues
      email: leadData.email || null,
      website: leadData.website || null,
      secondary_email: leadData.secondary_email || null,
      enquiry_form_google: leadData.enquiry_form_google || null,
      enquiry_form_direct: leadData.enquiry_form_direct || null,
      created_by: dbUser.id,
      assigned_to: dbUser.id,
      created_at: result.lead.created_at || new Date().toISOString(),
    });
  }

  if (validLeads.length === 0) {
    return NextResponse.json({
      total: rows.length,
      imported: 0,
      skipped: 0,
      errors: errors.slice(0, 50),
      warnings: warnings.slice(0, 50),
    });
  }

  // Duplicate detection by email
  const emailsToCheck = validLeads
    .map((l) => l.email as string | null)
    .filter((e): e is string => !!e);

  let existingEmails = new Set<string>();
  if (emailsToCheck.length > 0) {
    const { data: existing } = await adminSupabase
      .from("leads")
      .select("email")
      .in("email", emailsToCheck);

    if (existing) {
      existingEmails = new Set(
        existing.map((e: { email: string }) => e.email.toLowerCase())
      );
    }
  }

  // Split into new and duplicate
  const newLeads: Array<Record<string, unknown>> = [];
  let skippedCount = 0;

  for (const lead of validLeads) {
    const email = lead.email as string | null;
    if (email && existingEmails.has(email.toLowerCase())) {
      skippedCount++;
      continue;
    }
    newLeads.push(lead);
  }

  // Bulk insert in batches
  let importedCount = 0;

  for (let i = 0; i < newLeads.length; i += BATCH_SIZE) {
    const batch = newLeads.slice(i, i + BATCH_SIZE);
    const { data: inserted, error: insertError } = await adminSupabase
      .from("leads")
      .insert(batch)
      .select("id");

    if (insertError) {
      errors.push({
        row: 0,
        message: `Batch insert error (rows ${i + 1}-${i + batch.length}): ${insertError.message}`,
      });
    } else {
      importedCount += inserted?.length || 0;
    }
  }

  // Audit log
  logAudit(adminSupabase, {
    entityType: "lead",
    entityId: "bulk-import",
    action: "create",
    performedBy: dbUser.id,
    changes: {
      import: {
        old: null,
        new: {
          total: rows.length,
          imported: importedCount,
          skipped: skippedCount,
          errors: errors.length,
        },
      },
    },
  });

  return NextResponse.json({
    total: rows.length,
    imported: importedCount,
    skipped: skippedCount,
    errors: errors.slice(0, 50),
    warnings: warnings.slice(0, 50),
  });
}
