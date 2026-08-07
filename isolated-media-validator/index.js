'use strict';

// ============================================================================
// Isolated Media Validator — Cloud Run Service (Request Handler)
// ============================================================================
// Substantiates: https://secureacademic.com/gdpr-architectural-background/#sec-3-1-1
// Last verified against production: 2026-08-07
// See CHANGELOG.md (2026-08-07): this file, ./call-from-backend.js, and
// ../infrastructure/media-validator-iam.md are new in this pass. They
// replace the previous framing, under which the Transcriber's backend read
// these bytes directly — see ../media-integrity-check/mediaIntegrityCheck.js
// for what changed there too, and ../signed-url-flow/issue-upload-url.js for
// the corresponding correction to that file's central claim.
//
// WHAT THIS DOES
// This is the request handler for a separate, single-purpose Cloud Run
// service (`sas-transcriber-media-validator`) that the main backend calls
// over HTTPS — see ./call-from-backend.js for that side. It is the ONLY
// process that reads the bytes of an uploaded audio file before a
// transcription job starts. The main backend never does.
//
// It asks Cloud Storage for the object's real size, downloads a bounded
// prefix — at most the first 2 MB — and hands that slice to the
// dependency-free parser in ../media-integrity-check/mediaIntegrityCheck.js.
// For a "non-fast-start" container (track metadata placed after the media
// payload — see that file's own header for why that happens in practice),
// the parser may ask for ONE further bounded follow-up read, capped at
// 8 MB, targeted at the exact byte offset it computed from sizes already
// declared in the header. Either way, this is a ranged read, never a
// download of the file.
//
// ISOLATION, NOT JUST DELEGATION
// This service runs under its own service account (`sas-validator-runtime`),
// which an IAM Condition on the bucket restricts to read-only access on the
// "pending/" upload prefix alone — see ../infrastructure/media-validator-iam.md
// for the exact binding and how to check it yourself. It requires
// authentication (Cloud Run's own IAM, "require authentication" — no
// `allUsers` invoker) and never accepts an unauthenticated request; there is
// deliberately no application-level auth/JWT-verification code here, because
// re-implementing it would be redundant with, and could only be weaker than,
// the platform-enforced check.
//
// FAIL-CLOSED CONTRACT WITH THE CALLER
// - 200 { ok: true, ... }   -> validation passed, caller may proceed.
// - 200 { ok: false, ... }  -> validation deliberately rejected the file.
// - 400                     -> malformed request (caller-side bug).
// - 5xx / timeout           -> infra failure. The caller (./call-from-backend.js)
//                              treats this identically to an explicit
//                              rejection: delete the object, refuse to start
//                              the job. This service never "fails open".
//
// WHAT'S DELIBERATELY DIFFERENT FROM PRODUCTION
// - The Cloud Storage bucket name, the GCP project ID, and this service's
//   own URL are replaced with placeholders throughout. The service account
//   *names* below (`sas-validator-runtime`, `sas-validator-caller`) and the
//   deployment region are shown as-is — see
//   ../infrastructure/media-validator-iam.md for why that line was drawn
//   where it was.
// - Otherwise unchanged from production: this is the same Express app,
//   deployed via Cloud Run's built-in "Function" source (inline editor,
//   Buildpacks), wrapped through @google-cloud/functions-framework.
// ============================================================================

const express = require('express');
const functions = require('@google-cloud/functions-framework'); // npm: @google-cloud/functions-framework
const { Storage } = require('@google-cloud/storage'); // npm: @google-cloud/storage
const { validateAudioContainer, checkSizeDurationRatio } = require('../media-integrity-check/mediaIntegrityCheck');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));

const GCS_BUCKET = process.env.GCS_BUCKET_NAME || 'your-bucket-name';

const HEADER_BYTES = parseInt(process.env.HEADER_BYTES || String(2 * 1024 * 1024), 10); // 2 MB default
const GCS_CALL_TIMEOUT_MS = parseInt(process.env.GCS_CALL_TIMEOUT_MS || '8000', 10);
// Hard cap on the ONE bounded follow-up read for a non-fast-start container —
// see mediaIntegrityCheck.js's own `needsOffset` doc-comment for the logic
// that decides when this is needed at all.
const SECONDARY_READ_MAX_BYTES = parseInt(process.env.SECONDARY_READ_MAX_BYTES || String(8 * 1024 * 1024), 10);
const ALLOWED_EXTS = (process.env.ALLOWED_EXTS || 'mp3,m4a,ogg,webm')
    .split(',')
    .map(e => e.trim())
    .filter(Boolean);

// No embedded key — picks up this Cloud Run revision's attached service
// account (sas-validator-runtime) via Application Default Credentials.
const storage = new Storage();

// Only objects matching this exact shape are ever looked up. This mirrors
// the object-naming scheme the backend generates (see
// ../signed-url-flow/issue-upload-url.js), and intentionally duplicates —
// rather than relies solely on — the bucket's IAM Condition (already scoped
// to the "pending/" prefix, see ../infrastructure/media-validator-iam.md).
// Two independent layers refusing the same class of malformed/out-of-scope
// object name is the point: defense in depth, not a substitute for the IAM
// boundary.
const OBJECT_NAME_PATTERN = new RegExp(`^pending/\\d+_[a-f0-9]{10}\\.(${ALLOWED_EXTS.join('|')})$`);

function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_timeout`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

app.get('/healthz', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

app.post('/validate', async (req, res) => {
    const body = req.body || {};
    const { objectName, durationSec } = body;

    if (typeof objectName !== 'string' || !OBJECT_NAME_PATTERN.test(objectName)) {
        return res.status(400).json({ error: 'invalid_object_name' });
    }
    if (typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec <= 0) {
        return res.status(400).json({ error: 'invalid_duration' });
    }

    // Safe to derive from the already-validated objectName (regex above
    // guarantees it's one of ALLOWED_EXTS).
    const ext = objectName.split('.').pop().toLowerCase();
    const file = storage.bucket(GCS_BUCKET).file(objectName);

    try {
        const [metadata] = await withTimeout(file.getMetadata(), GCS_CALL_TIMEOUT_MS, 'metadata');
        const fileSize = parseInt(metadata.size, 10);

        // Fuzzy signal only — logged for calibration, never used to reject
        // on its own. See mediaIntegrityCheck.js's own header for why.
        const ratio = checkSizeDurationRatio(fileSize, durationSec, ext);
        console.log(
            `[Validator] ratio=${ratio.bytesPerSecond.toFixed(0)}B/s ext=${ext} ` +
            `size=${fileSize} duration=${durationSec}s suspicious=${ratio.suspicious}`
        );

        const rangeEnd = Math.max(Math.min(fileSize, HEADER_BYTES) - 1, 0);
        const [headerBuf] = await withTimeout(
            file.download({ start: 0, end: rangeEnd }),
            GCS_CALL_TIMEOUT_MS,
            'download'
        );

        const verdict = await validateAudioContainer({
            buffer: headerBuf,
            claimedExt: ext,
            maxSecondaryReadBytes: SECONDARY_READ_MAX_BYTES,
            // Only ever invoked for ISO-BMFF (mp4/m4a), and only once, when
            // the header prefix alone wasn't enough. `endExclusive` is
            // exclusive; file.download's `end` is inclusive, hence the -1.
            fetchRange: async (start, endExclusive) => {
                const secondaryEnd = Math.min(endExclusive, fileSize) - 1;
                if (secondaryEnd < start) return null;
                const [buf] = await withTimeout(
                    file.download({ start, end: secondaryEnd }),
                    GCS_CALL_TIMEOUT_MS,
                    'secondary_download'
                );
                return buf;
            },
        });

        if (!verdict.ok) {
            console.warn(`[Validator] REJECTED reason=${verdict.reason} objectName=${objectName}`);
        }

        return res.status(200).json({ ...verdict, ratio });

    } catch (err) {
        if (err && err.code === 404) {
            // Plausible race: the orphan sweeper or a force-delete on the
            // backend removed the object between upload completion and this
            // call. Not an infra failure — a clean, expected "reject".
            console.warn(`[Validator] object_not_found objectName=${objectName}`);
            return res.status(200).json({ ok: false, reason: 'object_not_found' });
        }
        // Anything else (timeout, transient GCS error, unexpected
        // exception) is an infra failure. Never logged with raw buffer
        // content — message only.
        console.error(`[Validator] internal_error objectName=${objectName} message=${err && err.message}`);
        return res.status(500).json({ error: 'validation_error' });
    }
});

// Minimal surface: anything else is a 404, no error detail leaked.
app.use((req, res) => res.status(404).end());

// Registers the whole Express app as the Cloud Run Function's HTTP handler
// — this is what the "Function entry point: validate" field on the Cloud
// Run service refers to. All routes/middleware above (/validate, /healthz,
// the 404 fallback) keep working exactly as-is, since Express itself still
// does the internal routing; functions-framework just owns the HTTP server.
functions.http('validate', app);

// Standalone/local execution only (e.g. `node index.js`, for local smoke
// testing outside of Cloud Run). When Cloud Run's Functions Framework
// runtime loads this file, it requires it as a module rather than executing
// it directly, so this block is skipped there and does not double-bind the
// port.
if (require.main === module) {
    const PORT = process.env.PORT || 8080;
    app.listen(PORT, () => {
        console.log(`[Validator] Listening on port ${PORT}, bucket=${GCS_BUCKET}, allowedExts=${ALLOWED_EXTS.join(',')}`);
    });
}
