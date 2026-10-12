'use strict';

// ============================================================================
// Proofreader Worker — Validation Before Any Credit Is Deducted
// ============================================================================
// Substantiates: https://secureacademic.com/gdpr-architectural-background/#sec-5-3
// Last verified against production: 2026-10-12
// See CHANGELOG.md (2026-10-12).
//
// WHAT THIS DOES
// Before a Proofreader job starts, the uploaded document is checked. That
// check used to run in the backend, which read the object's metadata. It now
// runs inside the Proofreader worker (Cloud Run, europe-west3), under its own
// identity. The backend sends an object name and a character count, and gets
// a verdict back: `{ ok: true }` or `{ ok: false, reason }`. It never
// receives the object or any part of it.
//
// The checks, in order:
//   1. The object must exist (`not_found` otherwise).
//   2. Its size must be plausible for the claimed character count: at most
//      8 bytes per character, and never more than 4 MiB in absolute terms
//      (`fraud_detected` otherwise).
//   3. Its content must be a JSON array of strings, which is the shape the
//      browser's tokenisation step produces (`invalid_payload` otherwise).
//      This used to fail only after the credits had been deducted.
//
// None of the checks logs content. Only counts and a reason code are logged.
//
// FAIL-CLOSED, ON THE BACKEND'S SIDE
// Any infrastructure error in this call is treated as a rejection: the
// backend deletes the uploaded object, deducts nothing, and answers 503.
// A rejected document is deleted as well (HTTP 400, `fraud_detected`).
//
// WHAT'S DELIBERATELY DIFFERENT FROM PRODUCTION
// The Express wiring, request parsing and the logging calls are omitted; the
// decision logic and the constants are the production ones. The object-name
// pattern mirrors the one `../signed-url-flow/issue-upload-url.js` generates.
// ============================================================================

// Only objects under this prefix are ever read or deleted by this worker.
const OBJECT_NAME_PATTERN = /^proofread_pending\/\d+_[a-f0-9]{10}\.[a-z0-9]{1,10}$/;

const MAX_BYTES_PER_CHAR = 8;               // the fraud ratio
const MAX_OBJECT_BYTES = 4 * 1024 * 1024;   // absolute ceiling, protects the worker's memory

function parseChunks(text) {
    let chunks;
    try {
        chunks = JSON.parse(text);
    } catch (e) {
        throw new Error('invalid_payload');
    }
    if (!Array.isArray(chunks) || !chunks.every(c => typeof c === 'string')) throw new Error('invalid_payload');
    return chunks;
}

/**
 * @param {object} bucket  - an @google-cloud/storage Bucket.
 * @param {{objectName: string, charCount: number}} request - already validated
 *        for shape: the name matches OBJECT_NAME_PATTERN, charCount is a finite
 *        positive number within the product limit.
 * @returns {Promise<{ok: boolean, reason?: string}>} a verdict, never content.
 */
async function validate(bucket, { objectName, charCount }) {
    let size;
    try {
        const [metadata] = await bucket.file(objectName).getMetadata();
        size = parseInt(metadata.size, 10);
    } catch (e) {
        if (e && e.code === 404) return { ok: false, reason: 'not_found' };
        throw e; // anything else is an infrastructure error: the caller fails closed
    }

    if (!Number.isFinite(size) || size > charCount * MAX_BYTES_PER_CHAR || size > MAX_OBJECT_BYTES) {
        return { ok: false, reason: 'fraud_detected' };
    }

    const [buf] = await bucket.file(objectName).download();
    try {
        parseChunks(buf.toString('utf8'));
    } catch (e) {
        return { ok: false, reason: 'invalid_payload' };
    }
    return { ok: true };
}

module.exports = { validate, OBJECT_NAME_PATTERN, MAX_BYTES_PER_CHAR, MAX_OBJECT_BYTES };
