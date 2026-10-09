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
| Dedicated host + redirects | `PUBLIC_FORMS_HOST` + `LEGACY_PUBLIC_FORMS_HOST` | **Production scope only**, after the DNS record is live. Old host 308-redirects the three paths (query string kept); the new host serves only the forms and 404s everything else. |

## Go-live order
1. DNS: CNAME `enquire` → Vercel; add `enquire.theworkvilla.com` as a domain on the Vercel project.
2. Set `NEXT_PUBLIC_GTM_ID` (and Turnstile keys if used) in Production, redeploy.
3. In GTM: cookie domain `.theworkvilla.com`, GA4 cross-domain linking `www` ↔ `enquire`, fire GA4 / Google Ads /
   Meta `Lead` on the `generate_lead` event.
4. Set `PUBLIC_FORMS_HOST` and `LEGACY_PUBLIC_FORMS_HOST` in Production, redeploy.
5. Switch the ad destination URLs to the new host.

Rollback: unset the two host variables (redirects stop instantly after redeploy); the old URLs never stopped working.
