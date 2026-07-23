'use strict';

// ============================================================================
// Daily Free Trial — IP-Based Abuse Prevention via One-Way Salted Hash
// ============================================================================
// Substantiates: https://secureacademic.com/gdpr-architectural-background/#sec-2-5
//                https://secureacademic.com/privacy-policy/#sec-4-9-1
// Last verified against production: 2026-07-23
//
// WHAT THIS DOES
// The free daily trial allocation uses IP-address-based abuse prevention,
// but the raw IP address is never stored. Instead, a SHA-256 hash of
// (IP + current date + a secret, server-side salt) is computed and stored.
//
//   - The date is embedded in the hash input, so the same visitor produces
//     a different hash every day: the stored value cannot be used to link
//     a visitor's activity across different days.
//   - The salt itself is a static, server-side secret (see "Configuration"
//     below) — it does not rotate. What changes daily is the date component
//     of the input, not the salt.
//   - Because the salt is a real secret rather than a hardcoded constant,
//     the hash cannot practically be reversed to recover the original IP
//     address by an outside party, even though the IPv4 address space is
//     small enough that a hash keyed only by a *known* value would be
//     trivially reversible.
//
// This module also includes the retention job: entries are deleted after a
// maximum of 3 days, matching the promise made in the privacy policy.
//
// WHAT'S DELIBERATELY DIFFERENT FROM PRODUCTION
// - Token/wallet issuance is simplified to the minimum needed to show the
//   hashing and rate-limiting mechanism; the full wallet-ledger bookkeeping
//   (accounting entries, credit amounts) has been omitted as business logic.
// - `FREE_TOKEN_SALT` has no fallback value, in code or in this file. If it
//   is not configured, the endpoint refuses the request (503) rather than
//   silently falling back to a guessable value — this fail-closed check was
//   added after an internal review found that production previously
//   contained a hardcoded fallback salt, which would have undermined the
//   irreversibility property described above. Fixed 2026-07-23.
// ============================================================================

const crypto = require('crypto');

/**
 * POST /api/free-token
 * Issues one free-trial allocation per IP address per calendar day.
 */
async function handleFreeTokenRequest(req, res, db) {
    try {
        const salt = process.env.FREE_TOKEN_SALT;
        if (!salt) {
            console.error('[API] CONFIG ERROR: FREE_TOKEN_SALT is not set. Refusing free-token requests.');
            return res.status(503).json({ error: 'SERVICE_UNAVAILABLE' });
        }

        const clientIp = req.ip;
        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        const ipHash = crypto.createHash('sha256')
                             .update(clientIp + today + salt)
                             .digest('hex');
        // The raw IP is never stored — only the hash, keyed by today's date.

        const alreadyUsed = await db.get(
            'SELECT used_date FROM free_tier_usage WHERE ip_hash = ? AND used_date = ?',
            [ipHash, today]
        );
        if (alreadyUsed) {
            return res.status(429).json({ error: 'LIMIT_REACHED' });
        }

        await db.run('INSERT INTO free_tier_usage (ip_hash, used_date) VALUES (?, ?)', [ipHash, today]);

        // (Wallet/credit issuance happens here in production; omitted — see
        // the header comment above.)

        return res.status(200).json({ success: true });
    } catch (error) {
        console.error('[API] Free Token Error', error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
}

/**
 * Retention job — run this on a schedule (production: hourly, alongside the
 * Orphan Sweeper described in ../deletion-lifecycle/orphan-sweeper.js).
 * Deletes any free_tier_usage row older than 3 days.
 */
async function cleanupExpiredFreeTrialHashes(db) {
    const deleted = await db.run("DELETE FROM free_tier_usage WHERE used_date < date('now', '-3 days')");
    if (deleted && deleted.changes > 0) {
        console.log(`[Sweeper] Cleaned up ${deleted.changes} old free-tier IP hashes (older than 3 days).`);
    }
    return deleted;
}

module.exports = { handleFreeTokenRequest, cleanupExpiredFreeTrialHashes };
