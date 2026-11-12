# Public enquiry forms — tracking, ad attribution, bot check, host

The three public forms (`/enquire` Google Ads, `/meta` Meta Ads, `/walkin` Walk-in) all POST to
`/api/public/enquiry`. Everything below is **off until its environment variable is set**, so the
forms behave exactly as before by default.

| Feature | Switched on by | Notes |
|---|---|---|
| Google Tag Manager on the three form pages only | `NEXT_PUBLIC_GTM_ID` (`GTM-XXXXXXX`) | GA4, Google Ads and the Meta Pixel are configured inside GTM. Never loaded in the logged-in CRM. |
| `generate_lead` dataLayer event | always (harmless without GTM) | `event_id` = enquiry reference (TWV-E-xxxx), for Meta browser/server de-duplication. |
| Ad attribution (UTMs, gclid/gbraid/wbraid, fbclid, `_fbp`, `_fbc`, landing URL, referrer) | always | Stored under `lead_enquiries.payload.attribution` (no migration). Shown as "Campaign: …" on the lead's Enquiries card. |
| Cloudflare Turnstile | `NEXT_PUBLIC_TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY` | Fails open: only an explicit invalid token rejects. A missing token is accepted and marked `payload.captcha = "missing"`. |
| Per-form hosts + redirects | `PUBLIC_FORM_HOSTS` + `LEGACY_PUBLIC_FORMS_HOST` | **Production scope only**, after the DNS records are live. `enquire.` / `meta.` / `walkin.theworkvilla.com` each serve their own form at `/` (URL stays on the short link) and 404 everything else. The legacy CRM host 308-redirects the three paths to them (query string kept). |

## Go-live order
1. Set `PUBLIC_FORM_HOSTS` in Production and redeploy (before any DNS change — a host attached to Vercel without it would show the CRM login). Add the three domains to the Vercel project. In GoDaddy, per subdomain: delete its Forwarding rule, then add a CNAME → `cname.vercel-dns.com`.
2. Set `NEXT_PUBLIC_GTM_ID` (and Turnstile keys if used) in Production, redeploy.
3. In GTM: cookie domain `.theworkvilla.com`, GA4 cross-domain linking `www` ↔ `enquire`, fire GA4 / Google Ads /
   Meta `Lead` on the `generate_lead` event.
4. Set `LEGACY_PUBLIC_FORMS_HOST` in Production, redeploy (optional; redirects direct vercel.app form URLs).
5. Existing short links need no change.

Rollback: re-create the GoDaddy forwarding rules and unset the host variables (redirects stop instantly after redeploy); the old URLs never stopped working.
