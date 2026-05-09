import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { generateAddendumPdf, type AddendumData } from "@/lib/addendum-generator";

/**
 * GET /api/contracts/[id]/addendum
 *
 * Generates and returns an addendum PDF for a renewal contract.
 * The contract must be a renewal (is_renewal = true).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Fetch the renewal contract with lead & location
  const { data: contract, error } = await supabase
    .from("contracts")
    .select(`
      *,
      lead:leads!contracts_lead_id_fkey(
        id, first_name, last_name, company, email,
        street, city, state, zip_code, country,
        pan_number, gst_number, entity_type
      ),
      location:locations!contracts_location_id_fkey(id, name, address, city, state)
    `)
    .eq("id", id)
    .single();

  if (error || !contract) {
    console.error("[addendum] Contract fetch failed:", error?.message, "id:", id);
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }

  if (!contract.is_renewal || !contract.parent_contract_id) {
    return NextResponse.json({ error: "Addendum can only be generated for renewal contracts" }, { status: 400 });
  }

  // Fetch parent contract separately (self-referencing FK join can be unreliable)
  const { data: parentData, error: parentError } = await supabase
    .from("contracts")
    .select("id, contract_number, start_date, end_date, subtotal, seats, tenure_months, agreement_date, items")
    .eq("id", contract.parent_contract_id)
    .single();

  if (parentError || !parentData) {
    console.error("[addendum] Parent contract fetch failed:", parentError?.message);
    return NextResponse.json({ error: "Parent contract not found" }, { status: 400 });
  }

  // Build lead details
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead = contract.lead as any;
  const clientName = lead?.company || [lead?.first_name, lead?.last_name].filter(Boolean).join(" ") || "Client";
  const contactPerson = lead?.company ? [lead?.first_name, lead?.last_name].filter(Boolean).join(" ") : undefined;
  const clientAddress = lead ? [lead.street, lead.city, lead.state, lead.zip_code, lead.country].filter(Boolean).join(", ") : undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const location = contract.location as any;

  const addendumData: AddendumData = {
    // Renewal
    renewal_contract_number: contract.contract_number,
    renewal_start_date: contract.start_date,
    renewal_end_date: contract.end_date,
    renewal_tenure_months: contract.tenure_months,
    renewal_subtotal: Number(contract.subtotal),
    renewal_total_amount: Number(contract.total_amount),
    renewal_tax_percentage: Number(contract.tax_percentage || 18),
    renewal_tax_amount: Number(contract.tax_amount || 0),
    renewal_escalation_percentage: Number(contract.escalation_percentage || 0),
    renewal_escalation_waived: !!contract.escalation_waived,
    renewal_seats: contract.seats || 1,
    renewal_billing_cycle: contract.billing_cycle || "monthly",
    renewal_sequence: contract.renewal_sequence || 2,
    renewal_items: (contract.items || []) as AddendumData["renewal_items"],

    // Parent
    parent_contract_number: parentData.contract_number,
    parent_start_date: parentData.start_date,
    parent_end_date: parentData.end_date,
    parent_subtotal: Number(parentData.subtotal),
    parent_seats: parentData.seats || 1,
    parent_tenure_months: parentData.tenure_months || 12,
    parent_agreement_date: parentData.agreement_date,

    // Client
    client_name: clientName,
    client_contact_person: contactPerson,
    client_designation: undefined,
    client_pan: lead?.pan_number || undefined,
    client_address: clientAddress,

    // Workspace
    workspace_description: contract.workspace_description || undefined,
    location_name: location?.name || undefined,
    location_address: location ? [location.address, location.city, location.state].filter(Boolean).join(", ") : undefined,

    // Date
    addendum_date: contract.agreement_date || new Date().toISOString().split("T")[0],
  };

  try {
    const pdf = generateAddendumPdf(addendumData);
    const pdfArrayBuffer = pdf.output("arraybuffer");
    const pdfBuffer = Buffer.from(pdfArrayBuffer);

    return new NextResponse(pdfBuffer, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="Addendum-${contract.contract_number}.pdf"`,
        "Content-Length": String(pdfBuffer.length),
      },
    });
  } catch (err) {
    console.error("[addendum] PDF generation failed:", err);
    return NextResponse.json({ error: "Failed to generate addendum PDF" }, { status: 500 });
  }
}
