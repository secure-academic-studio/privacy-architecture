# Changelog

Notable updates to this repository — corrections, re-verifications against production, and additions. See [Keeping this in sync](./README.md#keeping-this-in-sync) for why this file exists.

## 2026-07-28

### Added — verification information for `infrastructure/gcp-organization-policy.md`

**What changed.** This was the one claim in the repository nobody outside the organisation could check for themselves — by nature, not by choice: granting external viewer access to the GCP organisation would expose far more than this one policy. The document already gave the exact commands a reader would need if they had that access; it now also carries the actual, dated output of running them against the live organisation and the live storage bucket.

**What the information shows.** The effective `gcp.resourceLocations` allow-list (organisation ID disclosed — it is the organisation's public identity, tied to the secureacademic.com domain, not an infrastructure secret) contains every EU region, zone, and multi-region alias described above — and, matching the document's most falsifiable claim, `europe-west2` (London) and `europe-west6` (Zurich) do not appear anywhere among its 66 entries. The bucket-level output — bucket name redacted, per [What this repository is not](../README.md#what-this-repository-is-not) — confirms `location: EU`, `uniform_bucket_level_access: true`, and `public_access_prevention: enforced`, matching the bucket-level hardening claims exactly.

**What this does and does not prove.** This remains self-reported information — a reader still cannot re-run these commands themselves, and nothing here is cryptographically bound to the date it claims. It is nonetheless a meaningful step up from an unverifiable claim: it is dated, exact, falsifiable against Google's own public documentation of what `eu-locations` should contain, and shows the actual field values rather than a paraphrase of them. The bucket name is redacted for consistency with this repository's existing policy on infrastructure identifiers (`signed-url-flow/issue-upload-url.js` does the same) — not because the name is otherwise secret; the signed-URL upload flow already exposes it to any browser DevTools session on the live site.

**Files touched.** `infrastructure/gcp-organization-policy.md`, `README.md` (a stated exception for the organisation ID, alongside the existing placeholder policy for project IDs, bucket names, and similar infrastructure identifiers).

### Fixed — `client-side/canvas-pixel-redaction.js`, scope of the redaction claim

**What was wrong.** The file's header described the pixel-masking and Audit Payload ZIP routines without stating which tools they apply to. Read in isolation, it could be mistaken for describing the PDF-to-Excel conversion architecture generally. In fact both routines apply to the single-file Bank Statement and Invoice Converters only: the Batch Bank Statement Converter and Batch Invoice Converter share the same backend ([§4.5](https://secureacademic.com/gdpr-architectural-background/#sec-4-5)) but deliberately omit both — pages are still rasterized client-side, but no masking UI is offered and no Audit ZIP is built.

**What this did and did not affect.** No code or production behaviour changed; this is a documentation-scope correction only. The claims the file makes about the single-file flow remain accurate — the gap was what it left unsaid about the batch flow.

**Fix.** A new header section states the scope explicitly: which tools the file covers, which don't use this code path, and a link to [§4.5](https://secureacademic.com/gdpr-architectural-background/#sec-4-5) for the two omitted steps and why. The file's `Last verified against production` date was updated in the same pass.

**How this was found.** Flagged during the same repository-wide review documented in the entries below (2026-07-27) as a scope gap worth its own pass, since it required cross-referencing [§4.5](https://secureacademic.com/gdpr-architectural-background/#sec-4-5) rather than a code-level defect.

**Files touched.** `client-side/canvas-pixel-redaction.js` (header only).

## 2026-07-27

### Changed — `media-integrity-check/` is now covered by the architecture document

**What changed.** This module was published here in the initial release *before* the architecture document described it, and both the README and the file's own header said so explicitly. The document has since been extended: [§3.1.1 Server-Side Media Validation](https://secureacademic.com/gdpr-architectural-background/#sec-3-1-1) now describes the check, and the README row and the file header point at it instead of announcing an intention.

**Why the section was written where it was.** §3.1 is titled "the Signed URL Architecture — the backend never sees the audio file", and its auditor's note previously claimed that a compromised backend "would have no access to the raw audio files". The media-integrity check is the clearest counter-example to that framing: it is the one place where the Transcriber's backend deliberately reads bytes from the uploaded object. §3.1.1 was therefore placed immediately after §3.1, so the qualification sits where the absolute claim used to be. The related correction to §3.1 and to this repository's `signed-url-flow/issue-upload-url.js` is recorded in a separate entry below.

**Scope stated precisely.** §3.1.1 and the file header both now state the exact extent of the read: at most the first 2 MB of the object, which for any file over that size means the container header region only — but for a file *under* 2 MB the range covers the whole object, so a short recording does pass through backend memory in full for the duration of the check. The `checkSizeDurationRatio` helper in this module is deliberately **not** described in the architecture document: in production it is log-only and not enforced, and documenting it as a control would overstate what it does.

**No code changed.** The module in this repository remains byte-identical to production apart from its repository header; that was re-verified in this pass, and its `Last verified against production` date updated accordingly.

**Files touched.** `media-integrity-check/mediaIntegrityCheck.js` (header only), `README.md`.

### Added — Layers 2 and 3 extended to the Academic Proofreader

**What changed in production.** Until now the Proofreader had only part of the five-layer deletion guarantee. Layers 1, 4 and 5 already applied to it, because they are properties of the shared bucket and the shared hourly sweeper. Layers 2 and 3 did not: there was no `finally`-block safety net around the processing job, and the client-side erasure call was a single fire-and-forget `fetch` whose outcome was never checked, with no retry cycle and no way for the user to learn that deletion had not been confirmed.

Both layers were implemented for the Proofreader, matching the Transcriber: a `finally` sweep in the processing job, a new `/api/proofread/force-delete` endpoint, and the same staged client flow — three automatic attempts with increasing back-off, followed by an explicit user choice between retrying by hand and deferring to Layers 4 and 5.

**Two deliberate asymmetries, documented rather than smoothed over.** The Proofreader deletes its input object *eagerly*, the moment the job has finished reading it, which is earlier than a `finally` block could; the `finally` is a safety net for the paths that never reach that point. And on the success path the result object is spared, because the browser still has to fetch it — Layer 3 removes it immediately afterwards. Both are visible in `finally-block-deletion.js`.

**Repository changes.** `on-demand-erasure.js` now expresses all four production endpoints (two per application) as two parameterised functions, in the same style as `../signed-url-flow/issue-upload-url.js`; the parameters are exactly what differs between the applications. `finally-block-deletion.js` gained the Proofreader variant as a second function, since its shape genuinely differs rather than merely being parameterised.

**Files touched.** `deletion-lifecycle/on-demand-erasure.js`, `deletion-lifecycle/finally-block-deletion.js`.

### Fixed — `/api/proofread/delete-result`, false success response

**What was wrong.** The Proofreader's on-demand erasure endpoint returned `{ success: true, deleted: true }` unconditionally. If the Cloud Storage delete failed for any reason other than "already gone" (HTTP 404), the endpoint still reported success. The Transcriber's equivalent endpoint has always returned HTTP 500 in that case.

**What this did and did not affect.** It had no user-visible effect at the time, for a specific reason: nothing was listening. The Proofreader had no retry cycle that this response could mislead — the client made one fire-and-forget call and ignored the result entirely. The object left behind was still removed by the hourly orphan sweeper (Layer 4) and, failing that, by the bucket lifecycle rule (Layer 5).

The bug mattered because of what was about to be built on top of it. A staged retry cycle keys off precisely this response; had Layer 3 been added without fixing it first, a genuine deletion failure would have been reported as success and every retry silently suppressed. It was therefore fixed before the retry cycle was introduced, not after.

**Fix.** A non-404 Cloud Storage error now returns HTTP 500 with `deleted: false`, matching the Transcriber. The reference file carries a comment explaining why this response must be honest.

**How this was found.** During the review that preceded extending Layer 3 to the Proofreader — the two endpoints were compared line by line before the client-side flow was ported.

**Files touched.** `deletion-lifecycle/on-demand-erasure.js`.

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
