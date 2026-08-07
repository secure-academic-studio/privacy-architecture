'use strict';

// ============================================================================
// Isolated Media Validator — Backend-Side Caller
// ============================================================================
// Substantiates: https://secureacademic.com/gdpr-architectural-background/#sec-3-1
//                https://secureacademic.com/gdpr-architectural-background/#sec-3-1-1
// Last verified against production: 2026-08-07
// See CHANGELOG.md (2026-08-07) for why this file is new, and
// ../infrastructure/media-validator-iam.md for the identities referenced
// below.
//
// WHAT THIS DOES
// This runs inside the main backend, immediately before a transcription job
// starts (replacing what used to be an in-process byte-level check). It
// calls out to the isolated validator service — see ./index.js — over
// HTTPS, and does nothing else: it sends an object name and a claimed
// duration, and receives a verdict back. It never opens the object itself,
// never imports a Cloud Storage client for this purpose, and never holds a
// credential capable of reading the object's bytes for this purpose.
//
// AUTHENTICATION WITHOUT A STATIC KEY
// The backend's own service account (the same wide identity used for the
// platform's other Google Cloud / AI calls, referenced elsewhere in this
// repository) is NOT the identity that calls the validator. The
// organisation's policy forbids issuing new service-account keys
// (`constraints/iam.managed.disableServiceAccountKeyCreation`), and even if
// it didn't, using the backend's wide identity directly here would defeat
// the point of isolating the validator in the first place — a credential
// capable of everything the backend can do is not a narrow one.
//
// Instead, the backend's identity IMPERSONATES a second, narrowly-scoped
// service account (`sas-validator-caller`) that holds nothing but
// `roles/run.invoker` on this one Cloud Run service — see
// ../infrastructure/media-validator-iam.md for the exact bindings and how to
// check them. The impersonation call yields a short-lived (five-minute) ID
// token; that token, not the backend's own credentials, is what the
// validator's Cloud Run "require authentication" check actually verifies.
//
// FEATURE FLAG (production, not shown here)
// In production this path sits behind an environment-variable flag, which
// falls back to an older, in-process check if unset — so the cut-over to
// this isolated design could be reverted instantly, without a redeploy, had
// anything gone wrong during rollout. That fallback is not reproduced here:
// this repository documents current, live behaviour, not a retired code
// path — see the note on scope in ../README.md.
//
// FAIL-CLOSED
// Any non-200 response, any network error, and any timeout are all surfaced
// identically: this function throws, and its caller (inside
// `/api/transcribe/start`, not shown here — it is the same endpoint
// described in ../signed-url-flow/) deletes the object and refuses to start
// the job. This function never manufactures a synthetic "ok" verdict.
//
// WHAT'S DELIBERATELY DIFFERENT FROM PRODUCTION
// - MEDIA_VALIDATOR_URL and MEDIA_VALIDATOR_CALLER_SA below are shown as
//   placeholders. In production they are environment variables holding the
//   real Cloud Run service URL and the full sas-validator-caller@... email
//   — and that email would otherwise disclose the GCP project ID, which
//   this repository does not publish (see ../README.md).
// - Otherwise unchanged: this is the same impersonation and fetch logic
//   production uses.
// ============================================================================

const { GoogleAuth, Impersonated } = require('google-auth-library'); // npm: google-auth-library

const MEDIA_VALIDATOR_URL = process.env.MEDIA_VALIDATOR_URL || 'https://your-media-validator-url.run.app';
const MEDIA_VALIDATOR_CALLER_SA = process.env.MEDIA_VALIDATOR_CALLER_SA || 'sas-validator-caller@YOUR_PROJECT_ID.iam.gserviceaccount.com';
const MEDIA_VALIDATOR_TIMEOUT_MS = parseInt(process.env.MEDIA_VALIDATOR_TIMEOUT_MS || '28000', 10);

// Reused across calls — google-auth-library handles the underlying token
// refresh itself; a fresh Impersonated client is only built once.
let impersonatedClient = null;
async function getImpersonatedClient() {
    if (!impersonatedClient) {
        // Explicit scope is required on the SOURCE client (the backend's own
        // wide identity) for it to be able to request an ID token on behalf
        // of the target identity at all — omitting it fails with
        // "invalid_scope: Invalid OAuth scope or ID token audience provided".
        const auth = new GoogleAuth({
            scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        });
        const sourceClient = await auth.getClient();
        impersonatedClient = new Impersonated({
            sourceClient,
            targetPrincipal: MEDIA_VALIDATOR_CALLER_SA,
            lifetime: 300, // seconds — this impersonated session is only valid this long
            delegates: [],
            targetScopes: ['https://www.googleapis.com/auth/cloud-platform'],
        });
    }
    return impersonatedClient;
}

/**
 * Calls the isolated validator service (./index.js). Fail-closed: any
 * network error, timeout, or non-200 HTTP response throws — the caller
 * treats that identically to an explicit rejection. Only a successful,
 * interpretable verdict returns normally.
 * @returns {Promise<{ok: boolean, reason?: string, details?: object, ratio?: object}>}
 */
async function callMediaValidator(objectName, durationSec) {
    const impersonated = await getImpersonatedClient();
    const idToken = await impersonated.fetchIdToken(MEDIA_VALIDATOR_URL);

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), MEDIA_VALIDATOR_TIMEOUT_MS);
    try {
        const resp = await fetch(`${MEDIA_VALIDATOR_URL}/validate`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${idToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ objectName, durationSec }),
            signal: controller.signal,
        });

        // 200 = an interpretable verdict (ok:true OR ok:false + reason).
        // Any other HTTP status (400 = a bug on this side, 5xx = the
        // validator's own infra failure) counts as an infra failure — thrown
        // onward, and handled fail-closed by the caller.
        if (resp.status !== 200) {
            let bodyText = '';
            try { bodyText = await resp.text(); } catch (e) {}
            throw new Error(`media_validator_http_${resp.status}: ${bodyText.slice(0, 200)}`);
        }

        return await resp.json();
    } finally {
        clearTimeout(timeoutHandle);
    }
}

module.exports = { callMediaValidator };
