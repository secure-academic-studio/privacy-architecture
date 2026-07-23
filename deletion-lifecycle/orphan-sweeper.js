'use strict';

// ============================================================================
// Five-Layer Deletion Guarantee — Layer 4: the Orphan Sweeper
// ============================================================================
// Substantiates: https://secureacademic.com/gdpr-architectural-background/#sec-3-2
// Last verified against production: 2026-07-23
//
// WHAT THIS DOES
// An hourly cron job that catches whatever Layers 2–3 might have missed —
// e.g. a network error or a browser crash that prevented the client-side
// erasure flow from ever running. It sweeps:
//
//   - GCS objects registered in the lifecycle tracker for more than 3 hours.
//     The 3-hour threshold is not arbitrary: it matches the platform's own
//     maximum permitted recording length, so the sweeper cannot mistake a
//     still-legitimately-processing, maximum-length job for an abandoned
//     one. Because the sweep itself only runs hourly, the practical worst
//     case is "up to approximately 4 hours", not exactly 3.
//   - Feedback messages older than 30 days (see privacy-policy §4.7).
//   - Free daily-trial IP hashes older than 3 days (see
//     ../abuse-prevention/daily-free-trial-hash.js and privacy-policy §4.9.1).
//
// WHAT'S DELIBERATELY DIFFERENT FROM PRODUCTION
// Nothing of substance. In production all three cleanup steps live in one
// function; here the free-trial-hash cleanup is imported from its own
// module (../abuse-prevention/daily-free-trial-hash.js) to avoid
// duplicating that file's logic across the repository.
// ============================================================================

const { cleanupExpiredFreeTrialHashes } = require('../abuse-prevention/daily-free-trial-hash');

const ORPHAN_THRESHOLD_MS = 3 * 60 * 60 * 1000; // 3 hours

async function orphanSweeper(db, { gcsStorage, GCS_BUCKET }) {
    try {
        // --- Step 1: sweep abandoned GCS objects (pending uploads, stale
        //     results) older than the 3-hour threshold. ---
        const threshold = Date.now() - ORPHAN_THRESHOLD_MS;
        const orphans = await db.all(
            'SELECT object_name FROM gcs_lifecycle_tracking WHERE created_at < ?',
            [threshold]
        );

        if (orphans.length > 0) {
            console.log(`[Sweeper] Found ${orphans.length} orphan file(s) in tracker. Sweeping...`);
        }

        for (const orphan of orphans) {
            let deleted = false;
            if (gcsStorage) {
                try {
                    await gcsStorage.bucket(GCS_BUCKET).file(orphan.object_name).delete();
                    deleted = true;
                } catch (e) {
                    if (e.code === 404) deleted = true; // already gone
                    else console.error('[Sweeper] Failed to delete', orphan.object_name);
                }
            }
            if (deleted) {
                await db.run('DELETE FROM gcs_lifecycle_tracking WHERE object_name = ?', [orphan.object_name]);
            }
        }

        // --- Step 2: delete feedback messages older than 30 days. ---
        const deletedFeedbacks = await db.run(
            "DELETE FROM feedbacks WHERE created_at < datetime('now', '-30 days')"
        );
        if (deletedFeedbacks && deletedFeedbacks.changes > 0) {
            console.log(`[Sweeper] Cleaned up ${deletedFeedbacks.changes} old feedback message(s) (older than 30 days).`);
        }

        // --- Step 3: delete free-trial abuse-prevention hashes older than
        //     3 days (see the imported module for the retention rationale). ---
        await cleanupExpiredFreeTrialHashes(db);

    } catch (e) {
        console.error('[Sweeper] Critical error', e);
    }
}

module.exports = { orphanSweeper, ORPHAN_THRESHOLD_MS };

// ----------------------------------------------------------------------------
// Production schedules this to run every hour:
//   setInterval(() => orphanSweeper(db, { gcsStorage, GCS_BUCKET }), 60 * 60 * 1000);
// ----------------------------------------------------------------------------
