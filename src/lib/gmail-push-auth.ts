import { auth as googleAuth } from "@googleapis/gmail";

/**
 * Verifies that a request to /api/email/inbound really came from our Google
 * Cloud Pub/Sub push subscription.
 *
 * That endpoint was previously unauthenticated. Because the pipeline had never
 * been switched on it was never exploitable in practice, but it must not be
 * enabled in that state: the request body supplies `historyId`, which the
 * handler writes straight to the app_settings checkpoint. Anyone who found the
 * URL could post a far-future historyId and every subsequent real email would
 * be skipped forever — silent, unrecoverable data loss. Each accepted message
 * also triggers a Claude extraction call, so an open endpoint is unauthenticated
 * spend.
 *
 * Pub/Sub push subscriptions can be configured to attach an OIDC token, which
 * Google signs. Verifying it proves the caller is our subscription and not
 * someone replaying a request shape.
 *
 * Configure the subscription with:
 *   --push-auth-service-account=<GMAIL_PUBSUB_SA_EMAIL>
 *   --push-auth-token-audience=<GMAIL_PUBSUB_AUDIENCE>
 *
 * Fails closed: if either variable is unset, every request is rejected. A
 * misconfigured deploy therefore ingests nothing rather than accepting
 * everything.
 */

export type PushAuthResult = { ok: true } | { ok: false; reason: string };

// Reused across invocations on a warm lambda so Google's certs are fetched
// once rather than per request.
const verifier = new googleAuth.OAuth2();

export async function verifyPubSubPush(
  authorizationHeader: string | null
): Promise<PushAuthResult> {
  const audience = process.env.GMAIL_PUBSUB_AUDIENCE;
  const serviceAccount = process.env.GMAIL_PUBSUB_SA_EMAIL;

  if (!audience || !serviceAccount) {
    return { ok: false, reason: "push_auth_not_configured" };
  }

  if (!authorizationHeader?.startsWith("Bearer ")) {
    return { ok: false, reason: "missing_bearer_token" };
  }

  const idToken = authorizationHeader.slice("Bearer ".length).trim();
  if (!idToken) return { ok: false, reason: "empty_bearer_token" };

  let payload;
  try {
    // Checks Google's signature, `aud`, and expiry. Throws on any mismatch.
    const ticket = await verifier.verifyIdToken({ idToken, audience });
    payload = ticket.getPayload();
  } catch {
    // Deliberately not surfacing the library message — it can echo token
    // contents into logs.
    return { ok: false, reason: "invalid_token" };
  }

  if (!payload) return { ok: false, reason: "empty_token_payload" };

  // verifyIdToken checks the audience but not who minted the token. Without
  // this, any Google-issued OIDC token carrying our audience would pass.
  if (payload.email !== serviceAccount || payload.email_verified !== true) {
    return { ok: false, reason: "unexpected_service_account" };
  }

  const issuer = payload.iss;
  if (issuer !== "https://accounts.google.com" && issuer !== "accounts.google.com") {
    return { ok: false, reason: "unexpected_issuer" };
  }

  return { ok: true };
}
