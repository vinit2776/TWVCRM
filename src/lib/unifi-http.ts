import { NextResponse } from "next/server";
import { UnifiConfigError } from "@/lib/unifi";

/**
 * Response for a failed UniFi site-config lookup in a route handler.
 * A missing/blank console is the caller's (or the location setup's) mistake,
 * so it is a 400 with the explanation, never a silent default.
 */
export function unifiConfigErrorResponse(err: unknown): NextResponse {
  if (err instanceof UnifiConfigError) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  console.error("[unifi] site config lookup failed:", err);
  return NextResponse.json({ error: "Could not resolve the UniFi site for this location" }, { status: 500 });
}
