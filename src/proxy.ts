import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import { hostForPath, isAllowedOnFormHost, parseFormHosts } from "@/lib/public-forms/hosts";

// Each public enquiry form is served from its own host (meta.theworkvilla.com, ...) so ad
// tracking cookies are first-party to theworkvilla.com and the short links already in use
// keep working. Unset by default, which makes everything below a no-op; set both in the
// *Production* scope only, so previews and local dev are never redirected.
//   PUBLIC_FORM_HOSTS         "host=/path,host=/path" — see src/lib/public-forms/hosts.ts
//   LEGACY_PUBLIC_FORMS_HOST  the old CRM host whose form paths should redirect to those hosts
export async function proxy(request: NextRequest) {
  const formHosts = parseFormHosts(process.env.PUBLIC_FORM_HOSTS);
  const legacyHost = process.env.LEGACY_PUBLIC_FORMS_HOST;
  const host = request.headers.get("host")?.split(":")[0]?.toLowerCase();
  const { pathname } = request.nextUrl;

  if (formHosts.size > 0 && host) {
    const formPath = formHosts.get(host);

    if (formPath) {
      // A form host serves only its forms — never the CRM login or dashboard.
      if (pathname === "/") {
        const target = request.nextUrl.clone();
        target.pathname = formPath;
        return NextResponse.rewrite(target); // URL bar stays on the short link
      }
      if (!isAllowedOnFormHost(pathname)) return new NextResponse("Not found", { status: 404 });
      return NextResponse.next();
    }

    if (legacyHost && host === legacyHost) {
      const newHost = hostForPath(formHosts, pathname);
      if (newHost) {
        const target = request.nextUrl.clone();
        target.host = newHost;
        target.port = "";
        target.protocol = "https:";
        // Keeps the query string (UTMs, click IDs); /meta/x style subpaths collapse to the root.
        target.pathname = "/";
        return NextResponse.redirect(target, 308);
      }
    }
  }

  return await updateSession(request);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|manifest\\.json|sw\\.js|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
