// Server Component — reads the env var directly at render time, no client
// JS needed. Renders nothing when connected to the production Supabase
// project; renders an unmissable banner otherwise. Deliberately fails
// "visible" rather than "silent" — an unrecognized or misconfigured
// Supabase URL still shows the banner, so a bad env var reads as an
// obvious warning rather than looking like production.
//
// This exists so nobody (human or agent) has to remember which URL/branch
// they're on to know if what's on screen is real customer data — see the
// 2026-09-01 incident in CLAUDE.md for why that mattered.
const PRODUCTION_SUPABASE_REF = "zlbvadtajetylacxevsm";

export function EnvironmentBanner() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const isProduction = url.includes(PRODUCTION_SUPABASE_REF);
  if (isProduction) return null;

  return (
    <div
      role="alert"
      className="sticky top-0 z-[100] w-full bg-amber-400 px-3 py-1.5 text-center text-xs font-semibold text-amber-950 shadow-sm"
    >
      🧪 STAGING — this is test data, not a real customer. Safe to click anything.
    </div>
  );
}
