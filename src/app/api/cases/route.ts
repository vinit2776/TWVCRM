import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createCaseSchema } from "@/lib/validations";
import { logAudit } from "@/lib/audit";
import { DOCUMENT_CHECKLISTS, COMPLIANCE_CHECKLISTS } from "@/lib/constants";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "25");
  const status = searchParams.get("status");
  const aggregator_id = searchParams.get("aggregator_id");
  const purpose = searchParams.get("purpose");
  const location_id = searchParams.get("location_id");
  const assigned_to = searchParams.get("assigned_to");
  const search = searchParams.get("search");
  const sort_by = searchParams.get("sort_by") || "created_at";
  const sort_order = searchParams.get("sort_order") || "desc";

  const offset = (page - 1) * limit;

  let query = supabase
    .from("cases")
    .select(
      "*, aggregator:aggregators!cases_aggregator_id_fkey(id, name, code), location:locations!cases_location_id_fkey(id, name, code), assignee:users!cases_assigned_to_fkey(id, full_name, email)",
      { count: "exact" }
    );

  if (status) query = query.eq("status", status);
  if (aggregator_id) query = query.eq("aggregator_id", aggregator_id);
  if (purpose) query = query.eq("purpose", purpose);
  if (location_id) query = query.eq("location_id", location_id);
  if (assigned_to) query = query.eq("assigned_to", assigned_to);
  if (search)
    query = query.or(
      `case_number.ilike.%${search}%,client_name.ilike.%${search}%,client_company_name.ilike.%${search}%,client_email.ilike.%${search}%,client_gst_number.ilike.%${search}%`
    );

  const ascending = sort_order === "asc";
  query = query
    .order(sort_by, { ascending })
    .range(offset, offset + limit - 1);

  const { data, error, count } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    data,
    pagination: {
      page,
      limit,
      total: count || 0,
      totalPages: Math.ceil((count || 0) / limit),
    },
  });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const result = createCaseSchema.safeParse(body);

  if (!result.success) {
    return NextResponse.json(
      { error: "Validation failed", details: result.error.issues },
      { status: 400 }
    );
  }

  const { data: dbUser } = await supabase
    .from("users")
    .select("id")
    .eq("auth_id", user.id)
    .single();

  // Auto-populate rate from aggregator rate card if not provided
  let rate = result.data.rate;
  if (!rate && result.data.aggregator_id) {
    const rateQuery = supabase
      .from("aggregator_rate_cards")
      .select("rate")
      .eq("aggregator_id", result.data.aggregator_id)
      .eq("purpose", result.data.purpose)
      .eq("is_active", true);

    if (result.data.location_id) {
      rateQuery.eq("location_id", result.data.location_id);
    }

    const { data: rateCard } = await rateQuery.limit(1).single();
    if (rateCard) {
      rate = rateCard.rate;
    }
  }

  // Insert the case
  const { data, error } = await supabase
    .from("cases")
    .insert({
      ...result.data,
      rate,
      status: "intake_received",
      created_by: dbUser?.id,
      assigned_to: result.data.assigned_to || dbUser?.id,
    })
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (data) {
    // Auto-generate document checklist rows from DOCUMENT_CHECKLISTS
    const purpose = result.data.purpose;
    const entityType = result.data.client_entity_type;
    const docChecklist = DOCUMENT_CHECKLISTS[purpose]?.[entityType] || [];

    const docRows = docChecklist.map((doc) => ({
      case_id: data.id,
      document_type: doc.type,
      label: doc.label,
      is_required: doc.required,
      status: "pending" as const,
    }));

    // Prepaid aggregators and direct clients both require a paid VO case
    // invoice before the Leave & License Agreement can execute — gated on
    // billing_statements.payment_status (see agreement/route.ts and
    // src/lib/case-invoicing.ts), not a manually uploaded document.

    if (docRows.length > 0) {
      await supabase.from("case_documents").insert(docRows);
    }

    // Auto-generate compliance check rows from COMPLIANCE_CHECKLISTS
    const complianceChecklist = COMPLIANCE_CHECKLISTS[purpose] || [];

    if (complianceChecklist.length > 0) {
      const complianceRows = complianceChecklist.map((check) => ({
        case_id: data.id,
        check_name: check.check_name,
        check_category: check.check_category,
        sort_order: check.sort_order,
        status: "pending" as const,
      }));

      await supabase.from("case_compliance_checks").insert(complianceRows);
    }

    // Audit log
    if (dbUser?.id) {
      logAudit(supabase, {
        entityType: "case",
        entityId: data.id,
        action: "create",
        performedBy: dbUser.id,
        changes: { record: { old: null, new: data } },
      });
    }
  }

  return NextResponse.json({ data }, { status: 201 });
}
