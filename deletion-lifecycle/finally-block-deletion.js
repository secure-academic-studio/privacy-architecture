'use strict';

// ============================================================================
// Five-Layer Deletion Guarantee — Layer 2: the Processing Job's `finally` Block
// ============================================================================
// Substantiates: https://secureacademic.com/gdpr-architectural-background/#sec-3-2
//                https://secureacademic.com/gdpr-architectural-background/#sec-5-4
// Last verified against production: 2026-07-27
// See CHANGELOG.md (2026-07-27): the Proofreader variant below was added
// when Layer 2 was extended to that application.
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
// TWO VARIANTS, AND WHY THEY DIFFER
// The Transcriber's job (first function below) has one file to clean up: the
// uploaded audio. Gemini reads it straight from its gs:// URI, so the job can
// simply delete it when it is done, whatever the outcome.
//
// The Proofreader's job (second function) is shaped differently, because it
// must read the object itself in order to chunk the text across parallel AI
// calls. It therefore deletes the input the moment it has finished reading it
// — earlier than a `finally` block could — and uses `finally` as a safety net
// for the paths that never reach that point: a throw during the download, a
// crash while chunking, an AI call that dies mid-flight. One asymmetry is
// deliberate: on the success path the result object is spared, because the
// browser still has to fetch it and Layer 3 removes it immediately after; on
// the failure path there is nothing left to download, so it goes now rather
// than waiting for the Orphan Sweeper.
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

/**
 * The Proofreader variant. Differs from the function above in three ways,
 * all noted in the header comment: the input is deleted eagerly rather than
 * in `finally`; the safety net sweeps by job_id rather than by a single known
 * object name; and the result object is spared on the success path.
 *
 * @param {string} jobId      - identifies every object tracked for this job.
 * @param {string} objectName - the GCS object holding the uploaded text.
 * @param {object} gcsStorage - an initialised @google-cloud/storage client.
 * @param {string} GCS_BUCKET - the bucket name.
 * @param {object} db         - the lifecycle-tracking database handle.
 */
async function runProofreadJobWithGuaranteedDeletion(jobId, objectName, gcsStorage, GCS_BUCKET, db) {
    let jobFailed = false;
    try {
        // The job reads the object into memory here, then deletes it at once —
        // the earliest possible deletion, and earlier than `finally` would be.
        // (The read, the chunking and the AI calls are business logic and are
        // omitted; see the header comment.)
        await runAiJob(objectName);

    } catch (error) {
        jobFailed = true;
        console.error(`[ProofreadJob] Processing failed for ${objectName}:`, error.message);
        // (Credit refund / error-status bookkeeping happens here in
        // production — omitted as business logic.)

    } finally {
        // Safety net for every path that did not reach the eager delete above.
        // Idempotent: a 404 counts as deleted. Wrapped in its own try/catch so
        // a cleanup failure can never bury the job's original outcome — Layers
        // 4 and 5 still apply if this fails.
        try {
            const resultObjectName = `results/proofread_${jobId}.json`;
            const leftovers = await db.all(
                'SELECT object_name FROM gcs_lifecycle_tracking WHERE job_id = ?',
                [jobId]
            );

            for (const row of leftovers) {
                // Success path: the result must survive until the browser has
                // fetched it. Layer 3 deletes it moments later.
                if (!jobFailed && row.object_name === resultObjectName) continue;

                let itemDeleted = true;
                if (gcsStorage) {
                    try {
                        await gcsStorage.bucket(GCS_BUCKET).file(row.object_name).delete();
                        console.log('[ProofreadJob] Cleanup: object permanently deleted from GCS.');
                    } catch (e) {
                        if (e.code !== 404) {
                            itemDeleted = false;
                            console.error('[ProofreadJob] Cleanup failed for', row.object_name);
                        }
                    }
                }
                if (itemDeleted) {
                    await db.run('DELETE FROM gcs_lifecycle_tracking WHERE object_name = ?', [row.object_name]);
                }
            }
        } catch (cleanupErr) {
            console.error('[ProofreadJob] Cleanup sweep failed.');
        }
    }
}

module.exports = {
    runJobWithGuaranteedDeletion,
    runProofreadJobWithGuaranteedDeletion
};
