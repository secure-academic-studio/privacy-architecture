'use strict';

// ============================================================================
// Signed URL Architecture — the Backend Never Sees the File
// ============================================================================
// Substantiates: https://secureacademic.com/gdpr-architectural-background/#sec-3-1
//                https://secureacademic.com/gdpr-architectural-background/#sec-5-3
// Last verified against production: 2026-07-23
//
// WHAT THIS DOES
// The typical upload flow has the client send a file to the application's
// own backend, which stores it and forwards it onward. Here the file goes
// directly from the browser to Google Cloud Storage via a short-lived,
// write-only Signed URL. The backend generates the URL — it never receives,
// buffers, or stores the file's bytes.
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
        // ../media-integrity-check/mediaIntegrityCheck.js, which validates
        // the actual bytes server-side once the upload completes.
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
