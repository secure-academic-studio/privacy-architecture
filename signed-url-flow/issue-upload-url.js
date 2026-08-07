'use strict';

// ============================================================================
// Signed URL Architecture — the Upload Never Passes Through the Backend
// ============================================================================
// Substantiates: https://secureacademic.com/gdpr-architectural-background/#sec-3-1
//                https://secureacademic.com/gdpr-architectural-background/#sec-5-3
// Last verified against production: 2026-08-07
// See CHANGELOG.md (2026-08-07) for a correction applied to the framing of
// this file's central claim since the previous verification (2026-07-27).
//
// WHAT THIS DOES
// The typical upload flow has the client send a file to the application's
// own backend, which stores it and forwards it onward. Here the file goes
// directly from the browser to Google Cloud Storage via a short-lived,
// write-only Signed URL. The backend generates the URL — the upload itself
// never passes through it, and no request this file handles ever contains
// file bytes.
//
// WHAT THIS DOES *NOT* MEAN
// It does not mean the object is beyond the backend's reach in principle.
// This process holds the Cloud Storage service-account credentials — that
// is precisely what allows it to sign a URL at all — so it *could* read an
// object whose name it knows. As of this pass, it exercises that capability
// in exactly one place, deliberately bounded and documented:
//
//   - The Proofreader's background job downloads the tokenised text into
//     memory, because it must be split into chunks and dispatched across
//     several parallel AI calls — something that cannot be delegated to a
//     storage URI. See §5.3:
//     https://secureacademic.com/gdpr-architectural-background/#sec-5-3
//
// That content is never written to disk or to a database. This is spelled
// out because "the backend never sees the file" is a stronger claim than
// this alone would support, and this repository is meant to be accurate
// rather than flattering.
//
// A second such case used to exist here: the Transcriber's media-integrity
// check used to read at most the first 2 MB of the uploaded object directly
// in this process. It no longer does. That check now runs inside a
// separate, single-purpose Cloud Run service, under its own IAM-restricted
// identity — this process calls it over HTTPS and gets back a verdict,
// never bytes. See ../isolated-media-validator/ and §3.1.1:
// https://secureacademic.com/gdpr-architectural-background/#sec-3-1-1
//
// This one function represents two near-identical production endpoints:
// `/api/transcribe/get-upload-url` (audio, folder "pending/") and
// `/api/proofread/get-upload-url` (document text, folder "proofread_pending/").
// They differ only in the allowed file extensions and the object-name
// prefix, both of which are parameters here.
//
// WHAT'S DELIBERATELY DIFFERENT FROM PRODUCTION
// - Credit/wallet verification is reduced to a single existence check;
//   the real accounting logic (cost calculation, ledger entries) is
//   business logic and has been omitted.
// - The real GCS bucket name is replaced with a placeholder.
// - The two production endpoints have been merged into one parameterised
//   function for readability; the Signed URL logic itself is unchanged.
// ============================================================================

const crypto = require('crypto');
const { Storage } = require('@google-cloud/storage'); // npm: @google-cloud/storage

const GCS_BUCKET = process.env.GCS_BUCKET_NAME || 'your-bucket-name';
const gcsStorage = new Storage();

/**
 * Issues a time-limited, write-only Signed URL for a direct browser-to-GCS
 * upload, and registers the object in the deletion-lifecycle tracker (see
 * ../deletion-lifecycle/) so it can never be "lost" without a record.
 *
 * @param {object} req.body        - { token, fileName, contentType }
 * @param {string} objectPrefix    - e.g. "pending/" or "proofread_pending/"
 * @param {string[]|null} allowedExts - whitelist of accepted extensions, or
 *                                      null to accept any (used by the
 *                                      Proofreader, which validates content
 *                                      type differently — see its own docs).
 */
async function issueUploadUrl(req, res, db, { objectPrefix, allowedExts = null }) {
    try {
        const { token, fileName, contentType } = req.body;

        if (!token) return res.status(402).json({ error: 'CREDIT_ERROR: Valid Token Required.' });

        const wallet = await db.get('SELECT credits FROM wallets WHERE token = ?', [token]);
        if (!wallet) return res.status(404).json({ error: 'CREDIT_ERROR: Token not found.' });

        const ext = (fileName || 'file').split('.').pop().toLowerCase() || 'bin';

        // Extension whitelist — prevents a client from bypassing the
        // browser-side check (e.g. renaming a video to .m4a) and uploading
        // an unsupported, more-expensive-to-process file type. See also
        // ../media-integrity-check/mediaIntegrityCheck.js, which the
        // isolated validator service (../isolated-media-validator/) uses to
        // check the actual bytes once the upload completes.
        if (allowedExts && !allowedExts.includes(ext)) {
            return res.status(400).json({
                error: `Unsupported file type. Allowed: ${allowedExts.join(', ').toUpperCase()}.`
            });
        }

        const rand = crypto.randomUUID().replace(/-/g, '').substring(0, 10);
        const objectName = `${objectPrefix}${Date.now()}_${rand}.${ext}`;

        const options = {
            version: 'v4',
            action: 'write',
            expires: Date.now() + 60 * 60 * 1000, // 1 hour
            contentType: contentType || 'application/octet-stream',
        };

        const [uploadUrl] = await gcsStorage.bucket(GCS_BUCKET).file(objectName).getSignedUrl(options);

        // Register the object in the lifecycle tracker BEFORE returning the
        // URL, so that even an upload that never completes is provably
        // accounted for and eventually swept — see ../deletion-lifecycle/.
        await db.run(
            'INSERT INTO gcs_lifecycle_tracking (object_name, created_at, status) VALUES (?, ?, ?)',
            [objectName, Date.now(), 'uploading']
        );

        return res.status(200).json({ uploadUrl, objectName });
    } catch (error) {
        console.error('[SignedURL] URL generation error', error);
        return res.status(500).json({ error: 'Failed to generate upload URL.' });
    }
}

module.exports = { issueUploadUrl };

// ----------------------------------------------------------------------------
// For reference — the client side of this flow (runs in the browser, not
// covered by this file's exports): the frontend PUTs the raw file straight
// to the Signed URL. The application's own backend is never in this path.
//
//   const xhr = new XMLHttpRequest();
//   xhr.open('PUT', uploadUrl, true);
//   xhr.setRequestHeader('Content-Type', mimeType);
//   xhr.upload.onprogress = (e) => { /* update progress bar */ };
//   xhr.send(fileBlob);
// ----------------------------------------------------------------------------
