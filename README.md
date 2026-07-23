# Privacy & Security Architecture — Verifiable Excerpts

**Secure Academic Studio** ([secureacademic.com](https://secureacademic.com)) publishes a technical deep-dive of its privacy and security architecture at [secureacademic.com/gdpr-architectural-background](https://secureacademic.com/gdpr-architectural-background/). This repository exists to make the mechanisms described in that document independently checkable — not just readable.

> A privacy promise is cheap. Public security ratings (TLS grades, header scores) say nothing about what happens to user data during actual processing. This repository, together with the architecture document above, is our attempt to move from "trust us" to "check for yourself."

## What this repository is

Sanitized, self-contained code excerpts and infrastructure configuration that correspond, module for module, to the mechanisms described in the architecture document: the GDPR startup guard, the signed-URL data flow, the multi-layer deletion guarantee, client-side redaction, HTML tokenisation, session encryption, and the daily free-trial abuse-prevention hash.

Each file is either lifted near-verbatim from production (where the code is already self-contained and carries no business-sensitive logic) or reconstructed as a minimal, faithful reference implementation of the exact mechanism described in the docs, with identifiers, hostnames, and internal values replaced by placeholders.

## What this repository is *not*

This is **not** the full production codebase, and it is **not** licensed or intended as a drop-in backend. Deliberately excluded, regardless of how the rest of this repository is licensed:

- Payment and credit-purchase logic (Creem webhook handling, product/price mappings, wallet accounting internals).
- Admin authentication and admin-only endpoints.
- The full public API route map (only the routes that a given mechanism requires to make sense are shown).
- AI prompt engineering (system instructions given to the Gemini models). These are a product differentiator, not a privacy mechanism, and disclosing them would mainly help competitors, not auditors.
- Real infrastructure identifiers: GCP project IDs, bucket names, database paths, and similar values are replaced with placeholders throughout.

If a claim on our site or in the architecture document isn't backed by something in here, that's a gap to report, not an oversight to assume — see [Reporting a discrepancy](#reporting-a-discrepancy) below.

## Repository status

This repository is being populated incrementally. The table below is the target structure; items not yet present are marked accordingly.

| Status | Path | Substantiates | What it proves |
|---|---|---|---|
| ✅ | `gdpr-compliance-guard/startup-guard.js` | [§2.1](https://secureacademic.com/gdpr-architectural-background/#sec-2-1) GDPR Compliance Guard | The server refuses to start without valid EU credentials; Vertex AI is hard-pinned to `location: 'eu'`. |
| ✅ | `infrastructure/gcp-organization-policy.md` | [§2.2](https://secureacademic.com/gdpr-architectural-background/#sec-2-2) Organisation-Level Resource Location Policy | The exported `gcp.resourceLocations` constraint enforced at the GCP organisation root — independent of application code. |
| ✅ | `security-middleware/helmet-csp-config.js` | [§2.3](https://secureacademic.com/gdpr-architectural-background/#sec-2-3) Defence Middleware | The whitelist-based CSP, attack-pattern filter, and bot-blocking middleware. |
| ✅ | `security-middleware/rate-limiters.js` | [§2.4](https://secureacademic.com/gdpr-architectural-background/#sec-2-4) Rate Limiting | Per-endpoint rate-limit configuration. |
| 🔜 | `abuse-prevention/daily-free-trial-hash.js` | [§2.5](https://secureacademic.com/gdpr-architectural-background/#sec-2-5) Account-Free Access + [privacy-policy §4.9.1](https://secureacademic.com/privacy-policy/#sec-4-9-1) | The salted SHA-256(IP + date + secret) hash used to enforce one free trial per day, its irreversibility, and its 3-day automatic deletion. |
| 🔜 | `signed-url-flow/issue-upload-url.js` | [§3.1](https://secureacademic.com/gdpr-architectural-background/#sec-3-1) / [§5.3](https://secureacademic.com/gdpr-architectural-background/#sec-5-3) Signed URL Architecture | The backend issues a time-limited, write-only GCS URL and never receives the file's bytes. |
| 🔜 | `deletion-lifecycle/finally-block-deletion.js` | [§3.2.2](https://secureacademic.com/gdpr-architectural-background/#sec-3-2) Five-Layer Deletion Guarantee, Layer 2 | Deletion runs in a `finally` block regardless of processing success or failure. |
| 🔜 | `deletion-lifecycle/on-demand-erasure.js` | [§3.2.3](https://secureacademic.com/gdpr-architectural-background/#sec-3-2) Five-Layer Deletion Guarantee, Layer 3 | Ownership-checked, user-triggered deletion with an automatic multi-attempt retry sweep. |
| 🔜 | `deletion-lifecycle/orphan-sweeper.js` | [§3.2.4](https://secureacademic.com/gdpr-architectural-background/#sec-3-2) Five-Layer Deletion Guarantee, Layer 4 | The hourly cron that clears any file left behind by a client-side failure. |
| 🔜 | `media-integrity-check/mediaIntegrityCheck.js` | *Not yet in the public doc* | A dependency-free container/format sniffer that rejects a renamed video masquerading as audio before it reaches the AI pipeline — an additional server-side gate not currently described on the site; we intend to add it to the architecture document. |
| 🔜 | `client-side/canvas-pixel-redaction.js` | [§4.1](https://secureacademic.com/gdpr-architectural-background/#sec-4-1) Client-Side Pixel Destruction | Redactions are burned into canvas pixels in the browser before the original PDF is discarded. |
| 🔜 | `client-side/html-tokenization.js` | [§5.2](https://secureacademic.com/gdpr-architectural-background/#sec-5-2) HTML Tokenisation | Structural HTML tags are replaced with tokens client-side before content is uploaded. |
| 🔜 | `client-side/sau-encryption.js` | [§5.1](https://secureacademic.com/gdpr-architectural-background/#sec-5-1) AES-GCM Encrypted .SAU Session File | Key derivation (PBKDF2) and AES-256-GCM encrypt/decrypt, entirely in the browser via the Web Crypto API. |

## Verifying a claim yourself

A few starting points that don't require reading the whole repository:

- **"The server can't start misconfigured"** — read `gdpr-compliance-guard/startup-guard.js`: the `process.exit(1)` calls are unconditional.
- **"Your file never touches the backend"** — read `signed-url-flow/issue-upload-url.js`: the request body it handles never contains file bytes, only a filename and content type.
- **"Deletion doesn't depend on success"** — read `deletion-lifecycle/finally-block-deletion.js`: the delete call is outside both the `try` and `catch` blocks.
- **"The redaction is real, not a visual overlay"** — read `client-side/canvas-pixel-redaction.js` and note that the output is a flattened raster image; there is no code path that reattaches the original vector/text layer afterward.

## Keeping this in sync

A public reference that silently drifts from production is worse than no reference at all. Each file below its status marker carries a `Last verified against production:` comment with a date. If you find a discrepancy between this repository, the architecture document, and the live site's actual behavior, that is exactly the kind of finding we want to hear about — see below.

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
