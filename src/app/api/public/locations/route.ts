import { NextResponse } from "next/server";
import { PUBLIC_FORM_LOCATIONS } from "@/lib/public-forms/locations";

export async function GET() {
  const data = PUBLIC_FORM_LOCATIONS.map((name) => ({ id: name, name }));
  return NextResponse.json({ data });
}
