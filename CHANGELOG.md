# Changelog

Notable updates to this repository — corrections, re-verifications against production, and additions. See [Keeping this in sync](./README.md#keeping-this-in-sync) for why this file exists.

## 2026-07-27

### Fixed — `deletion-lifecycle/on-demand-erasure.js`, `forceDelete`

**What was wrong.** `forceDelete` sweeps every GCS object still tracked for a job. If one object in that sweep failed to delete from GCS for a reason other than "already gone" (HTTP 404), a single shared `allDeleted` flag flipped to `false` for the rest of the loop. Every object processed *after* that failure — even ones that deleted from GCS successfully — then also had its row-removal skipped, because the condition for clearing a row from `gcs_lifecycle_tracking` depended on the batch-wide flag rather than that object's own outcome.

**What this did and did not affect.** The underlying GCS objects were still deleted correctly in every case; this was not a data-retention issue. It affected only the accuracy of the internal `gcs_lifecycle_tracking` bookkeeping table, which could show already-deleted objects as still "pending" after a partial batch failure. In production, any row left in this state is independently cleared by the hourly orphan sweeper ([§3.2.4](https://secureacademic.com/gdpr-architectural-background/#sec-3-2), `orphan-sweeper.js`), which re-attempts the delete, treats the resulting 404 as success, and removes the row — typically within one to three hours. The defense-in-depth layer already limited the practical effect of this bug before it was fixed at the source.

**Fix.** The row-removal decision is now scoped to each object's own outcome for that loop iteration, not the shared batch flag. The batch-wide flag is still used for the endpoint's overall success/failure response (`200` vs. `500`), which is unchanged.

**How this was found.** Flagged during an external code-level review of this repository against the claims in [§3.2](https://secureacademic.com/gdpr-architectural-background/#sec-3-2) of the architecture document. Reproduced and fixed in production first; this repository was then updated to match.

**Files touched.** `deletion-lifecycle/on-demand-erasure.js` (`forceDelete`). The `Last verified against production` date on that file has been updated accordingly.
