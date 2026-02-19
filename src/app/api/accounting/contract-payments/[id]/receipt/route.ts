import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// GET — generate receipt data for a contract payment
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: payment, error } = await supabase
    .from("contract_payments")
    .select(
      "*, contract:contracts!contract_payments_contract_id_fkey(id, contract_number, title, lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company, email, pan_number)), creator:users!contract_payments_created_by_fkey(id, full_name), collector:users!contract_payments_collected_by_fkey(id, full_name)"
    )
    .eq("id", id)
    .single();

  if (error || !payment) {
    return NextResponse.json({ error: "Payment not found" }, { status: 404 });
  }

  // Format receipt data
  const paymentModeLabels: Record<string, string> = {
    cash: "Cash",
    upi: "UPI",
    card: "Card",
    bank_transfer: "Bank Transfer",
    razorpay: "Razorpay",
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const paymentData = payment as any;
  const receipt = {
    receipt_number: paymentData.payment_number,
    date: paymentData.payment_date,
    company: paymentData.contract?.lead?.company || `${paymentData.contract?.lead?.first_name} ${paymentData.contract?.lead?.last_name}`,
    pan_number: paymentData.contract?.lead?.pan_number || null,
    contract_number: paymentData.contract?.contract_number,
    contract_title: paymentData.contract?.title,
    amount: paymentData.amount,
    payment_mode: paymentModeLabels[paymentData.payment_mode] || paymentData.payment_mode,
    payment_reference: paymentData.payment_reference,
    notes: paymentData.notes,
    received_by: paymentData.creator?.full_name || paymentData.collector?.full_name,
    status: paymentData.status,
    created_at: paymentData.created_at,
    // Issuer info
    issuer: {
      name: "SREE DESIGN INFRASTRUCTURE PVT LTD",
      brand: "The WorkVilla",
      address: "Prakash Presidium, 110, MG Road, Nungambakkam, Chennai - 600034",
      phone: "+91 97910 97900",
      gst: "33AAACU4245J1ZF",
    },
  };

  return NextResponse.json({ data: receipt });
}
