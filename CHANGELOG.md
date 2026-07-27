# Changelog

Notable updates to this repository — corrections, re-verifications against production, and additions. See [Keeping this in sync](./README.md#keeping-this-in-sync) for why this file exists.

## 2026-07-27

### Fixed — `security-middleware/helmet-csp-config.js`, `styleSrc`

**What was wrong.** This file listed `styleSrc: ["'self'"]`, while production also allowed a SHA-256 hash for one inline `<style>` block. Its own header stated "Nothing of substance. This is the real directive set" — which, for that one directive, was not accurate.

**The larger part of the problem was in production, not here.** The hash production was serving (`sha256-HIQisee…`) did not match *any* inline `<style>` block on the site. It had been generated against an earlier version of the block and never regenerated after the block's content changed. Browsers were therefore blocking the site's own critical inline style on all 15 pages that carry it, and logging a CSP violation on every load.

**What this did and did not affect.** It did not weaken security. A stale hash fails closed: the style was blocked, which is the safe direction, and no unintended inline style became executable. The effect was cosmetic — the block exists to prevent a flash of unstyled content before the external stylesheet loads, so that flash simply returned. Because the repository omitted the hash entirely rather than showing the stale one, the two inaccuracies happened to cancel out visually, which is why neither was noticed sooner.

**Fix.** The hash was recomputed from the live block (`sha256-2PEbkGLm…`), corrected in production, and this file updated to match. The file now also documents what the hash covers and carries an explicit warning that it must be regenerated if the block changes, including the command to do so.

**How this was found.** During a claim-by-claim review of the architecture document against production, the CSP excerpt in [§2.3](https://secureacademic.com/gdpr-architectural-background/#sec-2-3) was compared with `server.js`; the hash was then verified by hashing every inline `<style>` block in the published HTML and finding no match.

**Files touched.** `security-middleware/helmet-csp-config.js`.

### Fixed — `signed-url-flow/issue-upload-url.js`, and two README claims

**What was wrong.** This file was titled "the Backend Never Sees the File" and stated that the backend "never receives, buffers, or stores the file's bytes". The README repeated the claim in two places, including under [Verifying a claim yourself](./README.md#verifying-a-claim-yourself) as *"Your file never touches the backend"*.

That framing conflates two different things. The upload genuinely does not pass through the backend — the bytes go from the browser straight to Cloud Storage, and no request handled here ever contains file content. But the backend holds the Cloud Storage service-account credentials, which is precisely what allows it to sign a URL; it can therefore read an object whose name it knows, and in two places it deliberately does.

**Fix.** The file's title and central claim now describe the upload path specifically, and a new section names both bounded reads explicitly: the Transcriber's media-integrity check, which reads at most the first 2 MB of the object ([§3.1.1](https://secureacademic.com/gdpr-architectural-background/#sec-3-1-1)), and the Proofreader's job, which downloads the tokenised text into memory to chunk it across parallel AI calls ([§5.3](https://secureacademic.com/gdpr-architectural-background/#sec-5-3)). Neither writes content to disk or to a database. The two README claims were rescoped to match.

**Corresponding changes on the site.** The architecture document was corrected in the same pass: the auditor's note in [§3.1](https://secureacademic.com/gdpr-architectural-background/#sec-3-1) previously asserted that "even a fully compromised application backend would have no access to the raw audio files", which does not follow from the upload path alone. [§3.1.1](https://secureacademic.com/gdpr-architectural-background/#sec-3-1-1) was added to document the media-integrity check, and [§5.3](https://secureacademic.com/gdpr-architectural-background/#sec-5-3) was rewritten to disclose the Proofreader's `file.download()` step.

**How this was found.** Same review pass. No behaviour changed in production as a result of this entry — this is a correction to how existing behaviour was described.

**Files touched.** `signed-url-flow/issue-upload-url.js`, `README.md`.

### Fixed — `deletion-lifecycle/on-demand-erasure.js`, `forceDelete`

**What was wrong.** `forceDelete` sweeps every GCS object still tracked for a job. If one object in that sweep failed to delete from GCS for a reason other than "already gone" (HTTP 404), a single shared `allDeleted` flag flipped to `false` for the rest of the loop. Every object processed *after* that failure — even ones that deleted from GCS successfully — then also had its row-removal skipped, because the condition for clearing a row from `gcs_lifecycle_tracking` depended on the batch-wide flag rather than that object's own outcome.

**What this did and did not affect.** The underlying GCS objects were still deleted correctly in every case; this was not a data-retention issue. It affected only the accuracy of the internal `gcs_lifecycle_tracking` bookkeeping table, which could show already-deleted objects as still "pending" after a partial batch failure. In production, any row left in this state is independently cleared by the hourly orphan sweeper ([§3.2.4](https://secureacademic.com/gdpr-architectural-background/#sec-3-2), `orphan-sweeper.js`), which re-attempts the delete, treats the resulting 404 as success, and removes the row — typically within one to three hours. The defense-in-depth layer already limited the practical effect of this bug before it was fixed at the source.

**Fix.** The row-removal decision is now scoped to each object's own outcome for that loop iteration, not the shared batch flag. The batch-wide flag is still used for the endpoint's overall success/failure response (`200` vs. `500`), which is unchanged.

**How this was found.** Flagged during an external code-level review of this repository against the claims in [§3.2](https://secureacademic.com/gdpr-architectural-background/#sec-3-2) of the architecture document. Reproduced and fixed in production first; this repository was then updated to match.

**Files touched.** `deletion-lifecycle/on-demand-erasure.js` (`forceDelete`). The `Last verified against production` date on that file has been updated accordingly.
