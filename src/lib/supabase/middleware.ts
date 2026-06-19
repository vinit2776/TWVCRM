import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function updateSession(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // ── Fast-path: skip auth check for routes that never need it ─────────────
  // auth.getUser() is a network call to Supabase Auth. API routes and most
  // public pages handle their own auth or don't need it at all. Skipping
  // the check here eliminates hundreds of unnecessary round-trips per day.
  const isApiRoute = pathname.startsWith("/api");
  const isPublicRoute =
    pathname === "/" ||
    pathname.startsWith("/enquire") ||
    pathname.startsWith("/meta") ||
    pathname.startsWith("/walkin") ||
    pathname.startsWith("/feedback") ||
    pathname.startsWith("/pay") ||
    pathname.startsWith("/verify") ||
    pathname === "/offline" ||
    pathname.startsWith("/asset");

  if (isApiRoute || isPublicRoute) {
    // Still need to return the supabaseResponse so cookie mutations propagate
    // (even if we skip the getUser call the SSR client may set refresh tokens).
    return NextResponse.next({ request });
  }

  // ── Auth check: only for dashboard pages and auth routes ─────────────────
  let supabaseResponse = NextResponse.next({
    request,
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({
            request,
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isAuthRoute =
    pathname.startsWith("/login") ||
    pathname.startsWith("/signup") ||
    pathname.startsWith("/forgot-password");

  // If user is not signed in and trying to access a protected page → login
  if (!user && !isAuthRoute) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // If user is signed in and hitting an auth page → dashboard
  if (user && isAuthRoute) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
