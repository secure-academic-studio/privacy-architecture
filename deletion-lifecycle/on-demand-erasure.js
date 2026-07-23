'use strict';

// ============================================================================
// Five-Layer Deletion Guarantee — Layer 3: Client-Initiated Erasure Flow
// ============================================================================
// Substantiates: https://secureacademic.com/gdpr-architectural-background/#sec-3-2
// Last verified against production: 2026-07-23
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
// WHAT'S DELIBERATELY DIFFERENT FROM PRODUCTION
// Nothing of substance — the ownership check, the sweep-all-tracked-objects
// behaviour, and the idempotent 404 handling are unchanged.
// ============================================================================

/**
 * POST /api/transcribe/delete-result
 * Deletes a single result object, after verifying the caller owns the job.
 */
async function deleteResult(req, res, db, { gcsStorage, GCS_BUCKET }) {
    try {
        const { jobId, token } = req.body;
        if (!jobId || !token) return res.status(400).json({ error: 'Missing parameters' });

        // Ownership check: only the token that started this job may delete it.
        const job = await db.get(
            'SELECT * FROM transcription_jobs WHERE job_id = ? AND token = ?',
            [jobId, token]
        );
        if (!job) return res.status(404).json({ error: 'Job not found' });

        const resultObjectName = `results/${jobId}.json`;
        let deletedFromGcs = false;

        if (gcsStorage) {
            try {
                await gcsStorage.bucket(GCS_BUCKET).file(resultObjectName).delete();
                deletedFromGcs = true;
            } catch (e) {
                if (e.code === 404) {
                    deletedFromGcs = true; // already gone — idempotent success
                } else {
                    console.error('[OnDemandErasure] Failed to delete', resultObjectName);
                    return res.status(500).json({ error: 'GCS Delete Failed' });
                }
            }
        }

        if (deletedFromGcs) {
            await db.run('DELETE FROM gcs_lifecycle_tracking WHERE object_name = ?', [resultObjectName]);
        }

        return res.status(200).json({ success: true, deleted: true });
    } catch (error) {
        console.error('[OnDemandErasure] Error', error);
        return res.status(500).json({ error: 'Internal error' });
    }
}

/**
 * POST /api/transcribe/force-delete
 * Sweeps every GCS object still tracked for a job — broader in scope than
 * deleteResult, used as the automatic retry target if step 1 fails.
 */
async function forceDelete(req, res, db, { gcsStorage, GCS_BUCKET }) {
    try {
        const { jobId, token } = req.body;
        if (!jobId || !token) return res.status(400).json({ error: 'Missing parameters' });

        const job = await db.get(
            'SELECT * FROM transcription_jobs WHERE job_id = ? AND token = ?',
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
            if (gcsStorage) {
                try {
                    await gcsStorage.bucket(GCS_BUCKET).file(t.object_name).delete();
                } catch (e) {
                    if (e.code !== 404) {
                        console.error('[ForceDelete] Failed to delete from GCS:', t.object_name);
                        allDeleted = false;
                    }
                }
            }
            if (allDeleted || !gcsStorage) {
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
// For reference — the client-side retry loop that calls forceDelete if
// deleteResult doesn't confirm success (runs in the browser):
//
//   const delays = [1000, 2000, 3000]; // ms
//   for (let i = 0; i < 3; i++) {
//       // UI: "Retrying deletion (i+1/3)..."
//       await sleep(delays[i]);
//       const res = await fetch('/api/transcribe/force-delete', { ... });
//       const data = await res.json();
//       if (res.ok && data.deleted) { success = true; break; }
//   }
//   // If all three attempts fail, the UI surfaces an explicit choice to the
//   // user rather than silently assuming success — see architecture doc §3.2.3.
// ----------------------------------------------------------------------------
