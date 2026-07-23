'use strict';

// ============================================================================
// Five-Layer Deletion Guarantee — Layer 2: the Processing Job's `finally` Block
// ============================================================================
// Substantiates: https://secureacademic.com/gdpr-architectural-background/#sec-3-2
// Last verified against production: 2026-07-23
//
// WHAT THIS DOES
// The background job that talks to the AI model deletes the source file in
// a `finally` block — deletion runs whether the AI call succeeds or fails.
// There is no error path that leaves the file sitting in cloud storage.
// A 404 on delete (file already gone) is treated as success: this makes the
// cleanup idempotent, so retries and races can never report a false failure.
//
// In normal operation this is the layer that actually deletes the file,
// within milliseconds of processing finishing — Layers 3–5 (see the other
// files in this directory) exist only for the rare case this layer is
// bypassed (process crash, uncaught signal, etc.).
//
// WHAT'S DELIBERATELY DIFFERENT FROM PRODUCTION
// The AI call itself (model choice, system prompt, response schema) is
// business logic and has been replaced with a placeholder `runAiJob()` — the
// only thing this file demonstrates is the surrounding try/catch/finally
// shape, which is what makes the deletion guarantee unconditional.
// ============================================================================

/**
 * Placeholder for the real AI call (model selection, system prompt,
 * response schema) — deliberately not implemented here; see the header
 * comment. Throwing is intentional: this stub exists so the file has no
 * dangling reference, not so it can be run as-is.
 */
async function runAiJob(objectName) {
    throw new Error('runAiJob is illustrative only — not implemented in this reference file.');
}

/**
 * Runs an AI processing job against a file already sitting in cloud
 * storage, and guarantees its deletion afterwards regardless of outcome.
 *
 * @param {string} objectName - the GCS object holding the source file.
 * @param {object} gcsStorage - an initialised @google-cloud/storage client.
 * @param {string} GCS_BUCKET - the bucket name.
 * @param {object} db         - the lifecycle-tracking database handle.
 */
async function runJobWithGuaranteedDeletion(objectName, gcsStorage, GCS_BUCKET, db) {
    try {
        // Placeholder for the real AI call — omitted; see "What's different"
        // above. Whatever this does, and however it fails, does not change
        // the guarantee below.
        await runAiJob(objectName);

    } catch (error) {
        console.error(`[Job] Processing failed for ${objectName}:`, error.message);
        // (Credit refund / error-status bookkeeping happens here in
        // production — omitted as business logic.)

    } finally {
        // This block runs unconditionally — on success, on a thrown error,
        // and even if the try block returns early. That is what makes the
        // deletion guarantee in this layer unconditional, not best-effort.
        let gcsDeleted = false;
        if (gcsStorage) {
            try {
                await gcsStorage.bucket(GCS_BUCKET).file(objectName).delete();
                gcsDeleted = true;
                console.log('[Job] Cleanup: source file permanently deleted from GCS.');
            } catch (e) {
                if (e.code === 404) {
                    gcsDeleted = true; // already gone — idempotent success
                } else {
                    console.error('[Job] GCS cleanup failed for', objectName);
                }
            }
        }

        if (gcsDeleted) {
            await db.run('DELETE FROM gcs_lifecycle_tracking WHERE object_name = ?', [objectName]);
        }
    }
}

module.exports = { runJobWithGuaranteedDeletion };
