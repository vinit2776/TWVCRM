import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const BASE_URL =
  (process.env.LEEGALITY_API_URL || "https://api.leegality.com/v3.0").trim();

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.LEEGALITY_API_KEY?.trim();
  const profileId = process.env.LEEGALITY_PROFILE_ID?.trim();
  const apiUrl = process.env.LEEGALITY_API_URL?.trim();
  const privateSalt = process.env.LEEGALITY_PRIVATE_SALT?.trim();
  const stampSeries = process.env.LEEGALITY_STAMP_SERIES?.trim();
  const environment = process.env.LEEGALITY_ENVIRONMENT?.trim() || "sandbox";

  const envCheck = {
    LEEGALITY_API_KEY: !!apiKey,
    LEEGALITY_PROFILE_ID: !!profileId,
    LEEGALITY_API_URL: !!apiUrl,
    LEEGALITY_PRIVATE_SALT: !!privateSalt,
    LEEGALITY_STAMP_SERIES: !!stampSeries,
  };

  const allEnvSet = Object.values(envCheck).every(Boolean);

  // Probe the Leegality API with a lookup for a non-existent document.
  // A 401 means the key is invalid; any other response (including 404 or 400)
  // means the key is recognised and the integration is live.
  let apiReachable = false;
  let apiStatusCode: number | null = null;
  let apiError: string | null = null;

  if (apiKey) {
    try {
      const res = await fetch(
        `${BASE_URL}/sign/request?documentId=HEALTHCHECK-${Date.now()}`,
        {
          method: "GET",
          headers: {
            "X-Auth-Token": apiKey,
            "Content-Type": "application/json",
          },
          // 5 second timeout
          signal: AbortSignal.timeout(5000),
        }
      );
      apiStatusCode = res.status;
      // 401 = bad key; everything else means Leegality accepted the auth
      apiReachable = res.status !== 401;
      if (!apiReachable) {
        const body = await res.text();
        apiError = `Authentication rejected (401): ${body.slice(0, 200)}`;
      }
    } catch (e) {
      apiError = e instanceof Error ? e.message : "Network error";
    }
  } else {
    apiError = "LEEGALITY_API_KEY is not configured";
  }

  return NextResponse.json({
    environment,
    baseUrl: BASE_URL,
    envCheck,
    allEnvSet,
    apiReachable,
    apiStatusCode,
    apiError,
    healthy: allEnvSet && apiReachable,
  });
}
