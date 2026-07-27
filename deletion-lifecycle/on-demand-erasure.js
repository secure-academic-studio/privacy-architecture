'use strict';

// ============================================================================
// Five-Layer Deletion Guarantee — Layer 3: Client-Initiated Erasure Flow
// ============================================================================
// Substantiates: https://secureacademic.com/gdpr-architectural-background/#sec-3-2
//                https://secureacademic.com/gdpr-architectural-background/#sec-5-4
// Last verified against production: 2026-07-27
// See CHANGELOG.md (2026-07-27) for two changes since the previous
// verification: a fix applied to forceDelete, and the extension of this
// layer to the Academic Proofreader.
//
// WHAT THIS DOES
// Two endpoints, used together as one staged flow:
//
//   1. `deleteResult` — called once, immediately after a result is ready.
//      Deletes exactly one object, after checking that the caller is the
//      legitimate owner (job_id AND token must both match).
//
//   2. `forceDelete` — called by the client only if step 1 doesn't confirm
//      success (network error, timeout). Unlike step 1, it re-queries every
//      object still tracked for the job and sweeps all of them, not just
//      the one originally targeted. The client retries this up to three
//      times with increasing back-off (see the reference snippet at the
//      bottom of this file) before surfacing an explicit choice to the
//      user rather than silently assuming deletion succeeded.
//
// Both endpoints treat a 404 from GCS (object already gone) as success —
// the same idempotence principle used in the `finally`-block layer.
//
// FOUR PRODUCTION ENDPOINTS, TWO FUNCTIONS
// This layer is implemented identically for both cloud-backed applications:
//
//   /api/transcribe/delete-result   /api/transcribe/force-delete
//   /api/proofread/delete-result    /api/proofread/force-delete
//
// They differ only in which jobs table proves ownership and how the result
// object is named, so both are expressed here as parameters. The architecture
// document claims parity between the two applications for this layer (§5.4);
// that claim is what these parameters make checkable.
//
// WHAT'S DELIBERATELY DIFFERENT FROM PRODUCTION
// The ownership check, the sweep-all-tracked-objects behaviour, and the
// idempotent 404 handling are unchanged. The four endpoints have been merged
// into two parameterised functions for readability, in the same way as
// ../signed-url-flow/issue-upload-url.js. `jobsTable` is a fixed internal
// constant chosen by the route, never user input — it is interpolated into
// SQL below, and would be an injection point if it were.
// ============================================================================

/**
 * POST /api/transcribe/delete-result  |  POST /api/proofread/delete-result
 * Deletes a single result object, after verifying the caller owns the job.
 *
 * @param {string}   jobsTable        - 'transcription_jobs' | 'proofread_jobs'
 * @param {function} resultObjectName - (jobId) => the object's name in GCS
 */
async function deleteResult(req, res, db, { gcsStorage, GCS_BUCKET, jobsTable, resultObjectName }) {
    try {
        const { jobId, token } = req.body;
        if (!jobId || !token) return res.status(400).json({ error: 'Missing parameters' });

        // Ownership check: only the token that started this job may delete it.
        const job = await db.get(
            `SELECT * FROM ${jobsTable} WHERE job_id = ? AND token = ?`,
            [jobId, token]
        );
        if (!job) return res.status(404).json({ error: 'Job not found' });

        const objectName = resultObjectName(jobId);
        let deletedFromGcs = false;

        if (gcsStorage) {
            try {
                await gcsStorage.bucket(GCS_BUCKET).file(objectName).delete();
                deletedFromGcs = true;
            } catch (e) {
                if (e.code === 404) {
                    deletedFromGcs = true; // already gone — idempotent success
                } else {
                    // A genuine GCS failure must never be reported as success:
                    // the client's retry cycle keys off this response, and a
                    // false `deleted: true` would silently suppress every
                    // retry. (Fixed in the Proofreader's copy on 2026-07-27 —
                    // see CHANGELOG.md.)
                    console.error('[OnDemandErasure] Failed to delete', objectName);
                    return res.status(500).json({ error: 'GCS Delete Failed', deleted: false });
                }
            }
        }

        if (deletedFromGcs) {
            await db.run('DELETE FROM gcs_lifecycle_tracking WHERE object_name = ?', [objectName]);
        }

        return res.status(200).json({ success: true, deleted: true });
    } catch (error) {
        console.error('[OnDemandErasure] Error', error);
        return res.status(500).json({ error: 'Internal error' });
    }
}

/**
 * POST /api/transcribe/force-delete  |  POST /api/proofread/force-delete
 * Sweeps every GCS object still tracked for a job — broader in scope than
 * deleteResult, used as the automatic retry target if step 1 fails.
 *
 * @param {string} jobsTable - 'transcription_jobs' | 'proofread_jobs'
 */
async function forceDelete(req, res, db, { gcsStorage, GCS_BUCKET, jobsTable }) {
    try {
        const { jobId, token } = req.body;
        if (!jobId || !token) return res.status(400).json({ error: 'Missing parameters' });

        const job = await db.get(
            `SELECT * FROM ${jobsTable} WHERE job_id = ? AND token = ?`,
            [jobId, token]
        );
        if (!job) return res.status(404).json({ error: 'Job not found' });

        const trackings = await db.all(
            'SELECT object_name FROM gcs_lifecycle_tracking WHERE job_id = ?',
            [jobId]
        );
        if (!trackings || trackings.length === 0) {
            return res.status(200).json({ success: true, deleted: true });
        }

        let allDeleted = true;

        for (const t of trackings) {
            // Each object's tracking row must be cleared based on its OWN outcome,
            // not the batch-wide flag — otherwise a single earlier GCS failure
            // leaves every subsequent successfully-deleted object's row stuck as
            // falsely "pending" in gcs_lifecycle_tracking. (Fixed 2026-07-27,
            // flagged via external code review of this repository — see CHANGELOG.md.)
            let itemDeleted = true;
            if (gcsStorage) {
                try {
                    await gcsStorage.bucket(GCS_BUCKET).file(t.object_name).delete();
                } catch (e) {
                    if (e.code !== 404) {
                        console.error('[ForceDelete] Failed to delete from GCS:', t.object_name);
                        itemDeleted = false;
                        allDeleted = false;
                    }
                }
            }
            if (itemDeleted) {
                await db.run('DELETE FROM gcs_lifecycle_tracking WHERE object_name = ?', [t.object_name]);
            }
        }

        if (allDeleted) {
            return res.status(200).json({ success: true, deleted: true });
        }
        return res.status(500).json({ error: 'Partial/GCS Delete Failed', deleted: false });
    } catch (error) {
        console.error('[ForceDelete] Error', error);
        return res.status(500).json({ error: 'Internal error', deleted: false });
    }
}

module.exports = { deleteResult, forceDelete };

// ----------------------------------------------------------------------------
// How the two applications wire these up in production:
//
//   const TRANSCRIBER = {
//       jobsTable: 'transcription_jobs',
//       resultObjectName: (jobId) => `results/${jobId}.json`
//   };
//   const PROOFREADER = {
//       jobsTable: 'proofread_jobs',
//       resultObjectName: (jobId) => `results/proofread_${jobId}.json`
//   };
//
// Everything else — the ownership check, the sweep, the 404 handling, the
// client-side retry cycle below — is the same code path for both.
// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------
// For reference — the client-side retry loop that calls forceDelete if
// deleteResult doesn't confirm success (runs in the browser):
//
//   const delays = [1000, 2000, 3000]; // ms
//   for (let i = 0; i < 3; i++) {
//       // UI: "Retrying deletion (i+1/3)..."
//       await sleep(delays[i]);
//       const res = await fetch('/api/<app>/force-delete', { ... });
//       const data = await res.json();
//       if (res.ok && data.deleted) { success = true; break; }
//   }
//   // If all three attempts fail, the UI surfaces an explicit choice to the
//   // user rather than silently assuming success — see architecture doc §3.2.3.
// ----------------------------------------------------------------------------
