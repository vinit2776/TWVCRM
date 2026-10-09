// Maps each public form to its own host, e.g. meta.theworkvilla.com -> /meta, so the
// short links already in ads and QR codes keep working while staying on our own domain.
//
// PUBLIC_FORM_HOSTS = "enquire.theworkvilla.com=/enquire,meta.theworkvilla.com=/meta,..."
// Unset (or empty) means no host gets special treatment.

export const FORM_PATHS = ["/enquire", "/meta", "/walkin"] as const;

export function parseFormHosts(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of (raw ?? "").split(",")) {
    const [host, path] = entry.split("=").map((s) => s.trim());
    if (host && path && (FORM_PATHS as readonly string[]).includes(path)) {
      map.set(host.toLowerCase(), path);
    }
  }
  return map;
}

/** The host that serves a given form path, used to redirect the old CRM-host URLs. */
export function hostForPath(hosts: Map<string, string>, pathname: string): string | undefined {
  const formPath = FORM_PATHS.find((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (!formPath) return undefined;
  for (const [host, path] of hosts) if (path === formPath) return host;
  return undefined;
}

// What a form host may serve: the forms, the two APIs they call, and the runtime's assets.
const ALLOWED_PREFIXES = [
  ...FORM_PATHS,
  "/api/public/enquiry",
  "/api/public/locations",
  "/_next",
  "/logo",
  "/favicon",
  "/icons",
];

export function isAllowedOnFormHost(pathname: string): boolean {
  return (
    ALLOWED_PREFIXES.some((p) => pathname.startsWith(p)) ||
    /\.(?:svg|png|jpg|jpeg|gif|webp|ico)$/.test(pathname)
  );
}
