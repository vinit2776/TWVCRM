import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { loadJourney } from "@/lib/journey/load";

// Read-only. Returns the computed customer journey for a lead. Never writes,
// never sends anything to the customer.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const journey = await loadJourney(createAdminClient(), id, {
    proposalId: searchParams.get("proposal_id"),
    contractId: searchParams.get("contract_id"),
  });
  if (!journey) return NextResponse.json({ error: "Lead not found" }, { status: 404 });

  return NextResponse.json({ data: journey });
}
