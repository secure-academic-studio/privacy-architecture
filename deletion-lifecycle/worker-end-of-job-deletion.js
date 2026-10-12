'use strict';

// ============================================================================
// Five-Layer Deletion Guarantee — Layer 2: the Worker's End-of-Job Deletion
// ============================================================================
// Substantiates: https://secureacademic.com/gdpr-architectural-background/#sec-3-2
//                https://secureacademic.com/gdpr-architectural-background/#sec-3-1-2
//                https://secureacademic.com/gdpr-architectural-background/#sec-5-4
// Last verified against production: 2026-10-12
// Renamed from `finally-block-deletion.js`; see CHANGELOG.md (2026-10-12) for
// why the old name and the old description no longer fit.
//
// WHAT THIS DOES
// The AI processing no longer runs in the main backend. Each application's
// job runs in its own Cloud Run worker (europe-west3), and the worker deletes
// the uploaded input itself. It does so on every terminal path of a job:
// success, AI error, timeout. The two functions below show where.
//
// This is not a literal `finally` block, and it is not claimed to be one:
// the job body is wrapped so that every failure becomes an `error` outcome,
// the content-free final status is written, and the delete follows. A 404 on
// delete (object already gone) counts as success, so retries and races can
// never report a false failure. A failed delete is logged without content
// and left to Layers 3-5. A worker instance killed mid-job never reaches the
// delete either; Layers 3-5 exist for exactly that case.
//
// The worker has no access to the backend's lifecycle-tracking database.
// A tracker row for an object the worker has already deleted is cleared
// later by Layer 3 or Layer 4, which treat the resulting 404 as success.
//
// TWO VARIANTS, AND WHY THEY DIFFER
// Transcriber: Gemini (and the optional Chirp timestamp pass) read the audio
// straight from its gs:// URI, so the worker never holds the bytes. It
// deletes the audio after both have finished, right after the final status.
// Proofreader: the worker must read the text itself to split it across
// parallel AI calls. It downloads the input into memory, deletes the object
// at once (the earliest possible point), and deletes again at the end as a
// safety net for the paths that never reached the first delete.
// On the success path the result object is deliberately left in place: the
// browser still has to fetch it, and Layer 3 removes it right afterwards.
//
// WHAT'S DELIBERATELY DIFFERENT FROM PRODUCTION
// The AI calls, prompts, retry logic, timestamp alignment, job claiming and
// token accounting are business logic and are replaced by `runAiJob()`. What
// is shown is the surrounding control flow, which is what the deletion claim
// depends on. `deleteObject` is the production function, with the log
// prefix generalised.
// ============================================================================

/**
 * Placeholder for the real AI call (model selection, system prompt,
 * response schema) — deliberately not implemented here; see the header
 * comment. Throwing is intentional: this stub exists so the file has no
 * dangling reference, not so it can be run as-is.
 */
async function runAiJob(input) {
    throw new Error('runAiJob is illustrative only — not implemented in this reference file.');
}

/**
 * Production maps an error to a fixed set of categories (overloaded,
 * content_blocked, api_error, ...). The error message itself is never
 * returned or logged: it could quote the user's content.
 */
function categorizeError(error) {
    return 'api_error';
}

/**
 * Idempotent delete. A 404 means the object is already gone, which is the
 * outcome we wanted. Any other failure is logged without content and left to
 * Layers 3-5.
 */
async function deleteObject(bucket, objectName, jobId, log = console) {
    try {
        await bucket.file(objectName).delete();
        log.log(`[Worker] job=${jobId} object_deleted`);
    } catch (e) {
        if (e && e.code === 404) return;
        log.error(`[Worker] job=${jobId} object_delete_failed`);
    }
}

/**
 * Transcriber variant. The audio is never downloaded: the AI service reads
 * it from its gs:// URI. The delete follows the final status on every path.
 *
 * @param {string}   jobId             - the job identifier.
 * @param {string}   objectName        - e.g. "pending/<ts>_<rand>.m4a".
 * @param {object}   bucket            - an @google-cloud/storage Bucket.
 * @param {function} writeFinalStatus  - writes status/<jobId>.json (content-free).
 */
async function runTranscriberJob(jobId, objectName, bucket, writeFinalStatus) {
    let outcome;
    try {
        outcome = await runAiJob(`gs://${bucket.name}/${objectName}`);
    } catch (e) {
        outcome = { state: 'error', errorCategory: categorizeError(e) };
    }

    await writeFinalStatus(jobId, outcome);
    await deleteObject(bucket, objectName, jobId);
    return outcome;
}

/**
 * Proofreader variant. The input is read into memory and deleted at once;
 * the delete at the end is the safety net for every path that did not get
 * that far (a throw during the download, a crash while chunking, an AI call
 * that dies mid-flight). Deleting an already deleted object is a no-op.
 *
 * @param {string}   jobId             - the job identifier.
 * @param {string}   objectName        - e.g. "proofread_pending/<ts>_<rand>.html".
 * @param {object}   bucket            - an @google-cloud/storage Bucket.
 * @param {function} writeFinalStatus  - writes status/proofread_<jobId>.json (content-free).
 */
async function runProofreaderJob(jobId, objectName, bucket, writeFinalStatus) {
    let outcome;
    try {
        // The earliest possible deletion: right after the read.
        const [buf] = await bucket.file(objectName).download();
        await deleteObject(bucket, objectName, jobId);

        const chunks = JSON.parse(buf.toString('utf8'));
        const issues = await runAiJob(chunks);

        // The result stays until the browser has fetched it; Layer 3 deletes it.
        await bucket.file(`results/proofread_${jobId}.json`)
            .save(JSON.stringify(issues), { contentType: 'application/json', resumable: false });
        outcome = { state: 'done' };
    } catch (e) {
        outcome = { state: 'error', errorCategory: categorizeError(e) };
    }

    await writeFinalStatus(jobId, outcome);
    await deleteObject(bucket, objectName, jobId); // safety net
    return outcome;
}

module.exports = {
    runTranscriberJob,
    runProofreaderJob
};
