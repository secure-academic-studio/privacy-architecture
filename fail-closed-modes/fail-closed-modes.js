'use strict';

// ============================================================================
// Fail-Closed Modes — a Lost Setting Cannot Send Your Material to the Backend
// ============================================================================
// Substantiates: https://secureacademic.com/gdpr-architectural-background/#sec-3-1-2
//                https://secureacademic.com/gdpr-architectural-background/#sec-5-3
// Last verified against production: 2026-10-12
// See CHANGELOG.md (2026-10-12).
//
// WHAT THIS DOES
// Each application (Transcriber, Proofreader) has exactly three operating
// modes, decided once at backend start-up from environment variables:
//
//   'remote'        The validation and the processing both run in Google
//                   Cloud (the validator and the worker). This is the
//                   production state.
//   'vps_fallback'  The remote path is incomplete, AND an explicit
//                   `*_ALLOW_VPS_FALLBACK=true` is set. Emergency use only.
//   'unavailable'   Neither. The endpoints answer HTTP 503, no credit is
//                   deducted, and anything already uploaded is deleted.
//
// The point of the third mode: a forgotten flag, a mistyped variable or a
// lost environment must not silently route a user's audio or text through
// the backend. The default for "not configured" is "not available", never
// "fall back to the old path".
//
// A DISCLOSED LIMIT, NOT A HIDDEN ONE
// The old in-backend processing code still exists in the backend's source,
// behind the two `*_ALLOW_VPS_FALLBACK` flags. Both are unset in production,
// so the mode is 'remote'. From the outside that is a claim about our
// configuration, not something a reader of this repository can verify. What
// can be verified here is the shape of the decision: nothing but an explicit
// opt-in reaches the fallback. In 'vps_fallback' mode the backend's
// identity would also need broader storage permissions than it holds (see
// ../infrastructure/iam-identity-map.md), so the fallback would fail at the
// storage layer even if it were switched on without that grant.
//
// WHAT'S DELIBERATELY DIFFERENT FROM PRODUCTION
// Production reads the flags inline at start-up and logs a warning in each
// non-'remote' mode. This file extracts the decision into one function and
// shows the guard every upload and start endpoint applies first.
// ============================================================================

/**
 * @param {boolean} remoteReady        - every part of the remote path is configured:
 *        Transcriber: remote validator AND remote worker (URLs and caller identities set);
 *        Proofreader: remote worker (URL and caller identity set).
 * @param {boolean} allowVpsFallback   - the explicit emergency opt-in.
 * @returns {'remote'|'vps_fallback'|'unavailable'}
 */
function resolveMode(remoteReady, allowVpsFallback) {
    if (remoteReady) return 'remote';
    return allowVpsFallback ? 'vps_fallback' : 'unavailable';
}

// Applied first in the get-upload-url and start endpoints of both
// applications: before the token is looked up, before any URL is signed.
function failClosedGuard(mode, res) {
    if (mode === 'unavailable') {
        res.status(503).json({ error: 'Service temporarily unavailable. Please try again later.' });
        return true; // the caller must return immediately
    }
    return false;
}

module.exports = { resolveMode, failClosedGuard };
