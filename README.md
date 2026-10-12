# Privacy & Security Architecture — Verifiable Excerpts

**Secure Academic Studio** ([secureacademic.com](https://secureacademic.com)) publishes a technical deep-dive of its privacy and security architecture at [secureacademic.com/gdpr-architectural-background](https://secureacademic.com/gdpr-architectural-background/). This repository exists to make the mechanisms described in that document independently checkable — not just readable.

> A privacy promise is cheap. Public security ratings (TLS grades, header scores) say nothing about what happens to user data during actual processing. This repository, together with the architecture document above, is our attempt to move from "trust us" to "check for yourself."

## What this repository is

Sanitized, self-contained code excerpts and infrastructure configuration that correspond, module for module, to the mechanisms described in the architecture document: the GDPR startup guard, the least-privilege identity map, the signed-URL data flow, the isolated Cloud Run workers, the fail-closed operating modes, the multi-layer deletion guarantee, client-side redaction, HTML tokenisation, session encryption, and the daily free-trial abuse-prevention hash.

Each file is either lifted near-verbatim from production (where the code is already self-contained and carries no business-sensitive logic) or reconstructed as a minimal, faithful reference implementation of the exact mechanism described in the docs, with identifiers, hostnames, and internal values replaced by placeholders.

## What this repository is *not*

This is **not** the full production codebase, and it is **not** licensed or intended as a drop-in backend. Deliberately excluded, regardless of how the rest of this repository is licensed:

- Payment and credit-purchase logic (Creem webhook handling, product/price mappings, wallet accounting internals).
- Admin authentication and admin-only endpoints.
- The full public API route map (only the routes that a given mechanism requires to make sense are shown).
- AI prompt engineering (system instructions given to the Gemini models). These are a product differentiator, not a privacy mechanism, and disclosing them would mainly help competitors, not auditors.
- Real infrastructure identifiers: GCP project IDs, bucket names, database paths, and similar values are replaced with placeholders throughout — with one stated exception: the GCP organization ID in [`infrastructure/gcp-organization-policy.md`](./infrastructure/gcp-organization-policy.md) is shown as-is, since it identifies the organization itself (tied to the public secureacademic.com domain) rather than any internal infrastructure detail.

If a claim on our site or in the architecture document isn't backed by something in here, that's a gap to report, not an oversight to assume — see [Reporting a discrepancy](#reporting-a-discrepancy) below.

## Repository status

All modules planned for the initial release are now in place. Future additions (new mechanisms, or updates following changes in production) will appear here first as 🔜 before being filled in.

| Status | Path | Substantiates | What it proves |
|---|---|---|---|
| ✅ | `gdpr-compliance-guard/startup-guard.js` | [§2.1](https://secureacademic.com/gdpr-architectural-background/#sec-2-1) GDPR Compliance Guard | The server refuses to start without valid EU credentials; Vertex AI is hard-pinned to `location: 'eu'`. |
| ✅ | `infrastructure/gcp-organization-policy.md` | [§2.2](https://secureacademic.com/gdpr-architectural-background/#sec-2-2) Organisation-Level Resource Location Policy | The exported `gcp.resourceLocations` constraint enforced at the GCP organisation root — independent of application code. |
| ✅ | `infrastructure/iam-identity-map.md` | [§2.6](https://secureacademic.com/gdpr-architectural-background/#sec-2-6) Least-Privilege Identity Map | Which identity holds which role on which object prefix: the backend can create and delete upload objects but cannot read or list them. Also states the one key exception and what the design does *not* claim. |
| ✅ | `security-middleware/helmet-csp-config.js` | [§2.3](https://secureacademic.com/gdpr-architectural-background/#sec-2-3) Defence Middleware | The whitelist-based CSP, attack-pattern filter, and bot-blocking middleware. |
| ✅ | `security-middleware/rate-limiters.js` | [§2.4](https://secureacademic.com/gdpr-architectural-background/#sec-2-4) Rate Limiting | Per-endpoint rate-limit configuration. |
| ✅ | `abuse-prevention/daily-free-trial-hash.js` | [§2.5](https://secureacademic.com/gdpr-architectural-background/#sec-2-5) Account-Free Access + [privacy-policy §4.9.1](https://secureacademic.com/privacy-policy/#sec-4-9-1) | The salted SHA-256(IP + date + secret) hash used to enforce one free trial per day, its irreversibility, and its 3-day automatic deletion. |
| ✅ | `signed-url-flow/issue-upload-url.js` | [§3.1](https://secureacademic.com/gdpr-architectural-background/#sec-3-1) / [§5.3](https://secureacademic.com/gdpr-architectural-background/#sec-5-3) Signed URL Architecture | The backend issues a time-limited, write-only GCS URL; the upload never passes through it. The file also states what the backend can and cannot do with an object afterwards, and discloses the one legacy exception. |
| ✅ | `deletion-lifecycle/worker-end-of-job-deletion.js` | [§3.2.2](https://secureacademic.com/gdpr-architectural-background/#sec-3-2) Five-Layer Deletion Guarantee, Layer 2 (see also [§3.1.2](https://secureacademic.com/gdpr-architectural-background/#sec-3-1-2)) | The Transcriber and Proofreader workers delete the uploaded input themselves on every terminal path of a job, after writing a content-free status. Renamed from `finally-block-deletion.js`; the old description no longer fit. |
| ✅ | `deletion-lifecycle/on-demand-erasure.js` | [§3.2.3](https://secureacademic.com/gdpr-architectural-background/#sec-3-2) Five-Layer Deletion Guarantee, Layer 3 | Ownership-checked, user-triggered deletion with an automatic multi-attempt retry sweep. |
| ✅ | `deletion-lifecycle/orphan-sweeper.js` | [§3.2.4](https://secureacademic.com/gdpr-architectural-background/#sec-3-2) Five-Layer Deletion Guarantee, Layer 4 | The hourly cron that clears any file left behind by a client-side failure. |
| ✅ | `media-integrity-check/mediaIntegrityCheck.js` | [§3.1.1](https://secureacademic.com/gdpr-architectural-background/#sec-3-1-1) Media Integrity Validation | A dependency-free container/format sniffer that rejects a renamed video masquerading as audio before it reaches the AI pipeline. Now runs inside the isolated service below, not the backend — see [`isolated-media-validator/`](./isolated-media-validator/). |
| ✅ | `isolated-media-validator/index.js` | [§3.1.1](https://secureacademic.com/gdpr-architectural-background/#sec-3-1-1) Media Integrity Validation | The Cloud Run request handler that performs the bounded byte read(s) and calls the parser above — entirely outside the backend. |
| ✅ | `isolated-media-validator/call-from-backend.js` | [§3.1](https://secureacademic.com/gdpr-architectural-background/#sec-3-1) / [§3.1.1](https://secureacademic.com/gdpr-architectural-background/#sec-3-1-1) | The backend's side of the call: an impersonation-derived, short-lived ID token, an object name and a duration out, a verdict back — never a byte. |
| ✅ | `infrastructure/media-validator-iam.md` | [§3.1.1](https://secureacademic.com/gdpr-architectural-background/#sec-3-1-1) Media Integrity Validation | The two service accounts and the IAM Condition that make "isolated" a checkable claim rather than an adjective. |
| ✅ | `remote-workers/proofreader-validate.js` | [§5.3](https://secureacademic.com/gdpr-architectural-background/#sec-5-3) Signed URL, the Isolated Worker, and the Content's Journey | The Proofreader's pre-flight check runs inside its worker, before any credit is deducted. The backend sends an object name and a character count and gets a verdict back. |
| ✅ | `fail-closed-modes/fail-closed-modes.js` | [§3.1.2](https://secureacademic.com/gdpr-architectural-background/#sec-3-1-2) / [§5.3](https://secureacademic.com/gdpr-architectural-background/#sec-5-3) | The three operating modes (`remote`, `vps_fallback`, `unavailable`): a lost setting yields HTTP 503, never a silent fall-back to the backend. Also discloses that the legacy in-backend code still exists behind two unset flags. |
| ✅ | `client-side/canvas-pixel-redaction.js` | [§4.1](https://secureacademic.com/gdpr-architectural-background/#sec-4-1) / [§4.2](https://secureacademic.com/gdpr-architectural-background/#sec-4-2) Client-Side Pixel Destruction + Audit Payload ZIP | Redactions are burned into canvas pixels in the browser before the original PDF is discarded; the Audit ZIP is pixel-identical to what is actually submitted. |
| ✅ | `client-side/html-tokenization.js` | [§5.2](https://secureacademic.com/gdpr-architectural-background/#sec-5-2) HTML Tokenisation | Structural HTML tags are replaced with tokens client-side before content is uploaded. |
| ✅ | `client-side/sau-encryption.js` | [§5.1](https://secureacademic.com/gdpr-architectural-background/#sec-5-1) AES-GCM Encrypted .SAU Session File | Key derivation (PBKDF2) and AES-256-GCM encrypt/decrypt, entirely in the browser via the Web Crypto API. |

## Verifying a claim yourself

A few starting points that don't require reading the whole repository:

- **"The server can't start misconfigured"** — read `gdpr-compliance-guard/startup-guard.js`: the `process.exit(1)` calls are unconditional.
- **"The upload never passes through the backend"** — read `signed-url-flow/issue-upload-url.js`: the request body it handles never contains file bytes, only a filename and content type. Note the scope of that claim: it is about the upload path. What the backend *can* do afterwards is a separate question, answered in the next point.
- **"The backend cannot read stored material"** — read `infrastructure/iam-identity-map.md`: the backend identity holds a custom role with `storage.objects.create` and `storage.objects.delete` only (no read, no list) on the upload and result prefixes; the workers and the validator are the only identities that can read, each limited to its own prefixes. The same document states what this does *not* claim, and the one exception (the backend's JSON key predates the organisation policy that forbids new keys).
- **"The Transcriber's backend never sees the audio file, full stop"** — read `isolated-media-validator/index.js` and `isolated-media-validator/call-from-backend.js` together: the backend sends an object name and a duration, nothing else, and the only process that opens the object before the job is a separate Cloud Run service running under its own IAM-restricted identity. `infrastructure/media-validator-iam.md` names exactly what that identity can, and cannot, reach. The transcription itself then runs in the Transcriber worker (§3.1.2), which reads the audio from its `gs://` URI inside Google Cloud.
- **"A lost setting cannot send your material to the backend"** — read `fail-closed-modes/fail-closed-modes.js`: nothing but an explicit opt-in flag reaches the old in-backend path, and that path remains in the source, disclosed, with both flags unset in production.
- **"Deletion doesn't depend on success"** — read `deletion-lifecycle/worker-end-of-job-deletion.js`: the job body turns every failure into an `error` outcome, and the delete follows the final status on both paths. A 404 counts as success; a failed delete is logged without content and left to Layers 3–5.
- **"The redaction is real, not a visual overlay"** — read `client-side/canvas-pixel-redaction.js` and note that the output is a flattened raster image; there is no code path that reattaches the original vector/text layer afterward.

## Keeping this in sync

A public reference that silently drifts from production is worse than no reference at all. Each file below its status marker carries a `Last verified against production:` comment with a date. If you find a discrepancy between this repository, the architecture document, and the live site's actual behavior, that is exactly the kind of finding we want to hear about — see below.

See [CHANGELOG.md](./CHANGELOG.md) for a dated history of corrections made to this repository, including what was wrong and why.

## Reporting a discrepancy

If something here doesn't match what you observe from the live application (via browser devtools, network inspection, or otherwise), please tell us:

- **support@secureacademic.com** — general contact.
- **privacy@secureacademic.com** — data protection / privacy-specific concerns (Tuta, Germany).

We treat a credible discrepancy report as a documentation or engineering bug, not as an inconvenience.

## License

Released under the [MIT License](./LICENSE). The reference implementations here are free to read, adapt, and reuse. This license applies only to the contents of this repository — see [What this repository is not](#what-this-repository-is-not) for what it deliberately does not cover.

## Related resources

- [Privacy and Security Architecture](https://secureacademic.com/gdpr-architectural-background/) — the full technical deep-dive this repository substantiates.
- [Privacy Policy](https://secureacademic.com/privacy-policy/) — the legal data-processing disclosures, including §4.9.1 on the free-trial hash mechanism.
- [secureacademic.com](https://secureacademic.com) — the product.
