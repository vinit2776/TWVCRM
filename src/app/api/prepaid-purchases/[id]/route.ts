import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// GET — fetch a single purchase with full redemption history
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  const { data, error } = await supabase
    .from("prepaid_purchases")
    .select(`
      *,
      package:prepaid_packages(id,name,credit_type,total_credits,workspace_type,validity_days,price),
      lead:leads(id,first_name,last_name,company,phone,email),
      location:locations(id,name),
      seller:sold_by(id,full_name),
      redemptions:prepaid_redemptions(
        id, credits_deducted, redeemed_at,
        booking:bookings(id,booking_number,booking_date,start_time,end_time,duration_hours)
      )
    `)
    .eq("id", id)
    .single();

  if (error || !data) return NextResponse.json({ error: "Purchase not found" }, { status: 404 });

  const creditsRemaining = Math.max(0, Number(data.total_credits) - Number(data.credits_used));
  let computedStatus = data.status;
  if (computedStatus === "active") {
    if (creditsRemaining <= 0) computedStatus = "exhausted";
    else if (new Date(data.expires_at) < new Date()) computedStatus = "expired";
  }

  return NextResponse.json({ data: { ...data, credits_remaining: creditsRemaining, status: computedStatus } });
}

// PATCH — extend expiry (admin action)
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await request.json();
  const { action, new_expires_at, extension_notes } = body;

  if (action !== "extend") {
    return NextResponse.json({ error: "Invalid action. Supported: 'extend'" }, { status: 400 });
  }

  if (!new_expires_at) {
    return NextResponse.json({ error: "new_expires_at is required" }, { status: 400 });
  }

  // Fetch current purchase to validate it exists
  const { data: existing } = await supabase
    .from("prepaid_purchases")
    .select("id, status, expires_at")
    .eq("id", id)
    .single();

  if (!existing) return NextResponse.json({ error: "Purchase not found" }, { status: 404 });

  if (existing.status === "exhausted") {
    return NextResponse.json({ error: "Cannot extend an exhausted purchase" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("prepaid_purchases")
    .update({
      expires_at: new_expires_at,
      status: "active",           // re-activate if it was expired
      extended_by: user.id,
      extended_at: new Date().toISOString(),
      extension_notes: extension_notes?.trim() || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select(`
      *,
      package:prepaid_packages(id,name,credit_type,total_credits,workspace_type),
      lead:leads(id,first_name,last_name,company,phone,email)
    `)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const creditsRemaining = Math.max(0, Number(data.total_credits) - Number(data.credits_used));
  return NextResponse.json({ data: { ...data, credits_remaining: creditsRemaining } });
}
