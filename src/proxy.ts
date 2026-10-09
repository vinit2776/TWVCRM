import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

// The three public enquiry forms move to their own host (e.g. enquire.theworkvilla.com) so
// ad tracking cookies are first-party to theworkvilla.com. Both variables are unset by
// default, which makes everything below a no-op; set them in the *Production* scope only,
// so previews and local dev are never redirected.
//   PUBLIC_FORMS_HOST         the new host
//   LEGACY_PUBLIC_FORMS_HOST  the old CRM host that should forward the form paths
const FORM_PATHS = ["/enquire", "/meta", "/walkin"];
// Everything the three forms (and the Next.js runtime) need on the public host.
const PUBLIC_HOST_ALLOWED_PREFIXES = [
  ...FORM_PATHS,
  "/api/public/enquiry",
  "/api/public/locations",
  "/_next",
  "/logo",
  "/favicon",
  "/icons",
];

const isFormPath = (pathname: string) =>
  FORM_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

export async function proxy(request: NextRequest) {
  const publicHost = process.env.PUBLIC_FORMS_HOST;
  const legacyHost = process.env.LEGACY_PUBLIC_FORMS_HOST;
  const host = request.headers.get("host")?.split(":")[0];
  const { pathname } = request.nextUrl;

  if (publicHost && legacyHost && host === legacyHost && isFormPath(pathname)) {
    const target = request.nextUrl.clone();
    target.host = publicHost;
    target.port = "";
    target.protocol = "https:";
    return NextResponse.redirect(target, 308); // keeps the query string (UTMs, click IDs)
  }

  // The public host serves only the forms — never the CRM login or dashboard.
  if (publicHost && host === publicHost) {
    if (pathname === "/") {
      const target = request.nextUrl.clone();
      target.pathname = "/enquire";
      return NextResponse.redirect(target, 307);
    }
    const allowed =
      PUBLIC_HOST_ALLOWED_PREFIXES.some((p) => pathname.startsWith(p)) ||
      /\.(?:svg|png|jpg|jpeg|gif|webp|ico)$/.test(pathname);
    if (!allowed) return new NextResponse("Not found", { status: 404 });
  }

  return await updateSession(request);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|manifest\\.json|sw\\.js|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
