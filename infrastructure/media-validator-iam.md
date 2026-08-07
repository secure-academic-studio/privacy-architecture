# Isolated Media Validator — IAM & Service Identity

Substantiates: [§3.1 The Signed URL Architecture](https://secureacademic.com/gdpr-architectural-background/#sec-3-1) / [§3.1.1 Media Integrity Validation](https://secureacademic.com/gdpr-architectural-background/#sec-3-1-1)
Last verified against production: 2026-08-07

## What this is

The [architecture document](https://secureacademic.com/gdpr-architectural-background/#sec-3-1-1) claims the backend never reads the bytes of an uploaded audio file for the media-integrity check — a separate, isolated Cloud Run service does, under its own identity. "Isolated" is a specific, checkable claim here, not an adjective: this document names exactly which identities exist, exactly what each one can do, and exactly what it cannot. See [`../isolated-media-validator/`](../isolated-media-validator/) for the code these identities run.

## The two identities

| Field | Runtime identity | Caller identity |
|---|---|---|
| Service account | `sas-validator-runtime@YOUR_PROJECT_ID.iam.gserviceaccount.com` | `sas-validator-caller@YOUR_PROJECT_ID.iam.gserviceaccount.com` |
| Attached to | The Cloud Run revision itself (`sas-transcriber-media-validator`) | Nothing — exists only to be impersonated |
| Grants | Read-only, IAM-Condition-scoped (see below) | `roles/run.invoker` on this one Cloud Run service, nothing else |
| Has a static key? | No | No — organisation policy `constraints/iam.managed.disableServiceAccountKeyCreation` forbids creating new service-account keys at all |
| Used by | The validator service, via Application Default Credentials | The backend, via short-lived impersonation (see below) |

Two separate identities, not one, because they answer two different questions: "what can read the audio bytes" (the runtime identity — nothing outside `pending/`) and "what can trigger a validation run" (the caller identity — nothing beyond invoking this one service). Collapsing them into a single identity would couple two properties that are more useful kept independently falsifiable.

## The IAM Condition restricting the runtime identity

```
Role:       roles/storage.objectViewer
Member:     sas-validator-runtime@YOUR_PROJECT_ID.iam.gserviceaccount.com
Resource:   YOUR_BUCKET_NAME (bucket-level binding)
Condition:  resource.name.startsWith("projects/_/buckets/YOUR_BUCKET_NAME/objects/pending/")
```

This is a genuine, evaluated-at-request-time restriction, not a naming convention: an attempt by this identity to read any object outside the `pending/` prefix — including the Transcriber's own `results/` prefix, or the Proofreader's `proofread_pending/` prefix on the same shared bucket — is denied by Cloud Storage itself, before this codebase's own object-name check (see [`../isolated-media-validator/index.js`](../isolated-media-validator/index.js)) even runs. The two checks are deliberately redundant: defense in depth, not a substitute for one another.

## Deployment shape

| Field | Value |
|---|---|
| Region | `europe-west3` (Frankfurt) — a concrete region within the `eu` multi-region the bucket itself uses; Cloud Run cannot deploy to a multi-region directly |
| Authentication | Cloud Run "require authentication" — no `allUsers` invoker, ever |
| Scaling | Min 0 / Max 5 |
| Request timeout | 25 seconds |

## How the backend calls this without a static key

The organisation-wide policy that forbids service-account key creation (see the table above) applies here too, and is not worked around: the backend's own wide identity — the same one behind its other Google Cloud / AI calls — is granted `roles/iam.serviceAccountTokenCreator` on the caller identity, and *only* that. At call time, the backend impersonates the caller identity to obtain a short-lived (five-minute) ID token, and that token — not the backend's own credentials — is what the validator's Cloud Run authentication layer actually checks. See [`../isolated-media-validator/call-from-backend.js`](../isolated-media-validator/call-from-backend.js) for the code.

## What's a placeholder here, and why

`YOUR_PROJECT_ID` and `YOUR_BUCKET_NAME` are placeholders throughout, consistent with this repository's existing policy ([`../signed-url-flow/issue-upload-url.js`](../signed-url-flow/issue-upload-url.js) does the same, for the same reasons — see [What this repository is not](../README.md#what-this-repository-is-not)). The service account *names* (`sas-validator-runtime`, `sas-validator-caller`, `sas-transcriber-media-validator`) and the region (`europe-west3`) are shown as-is: on their own, without the project ID that would turn them into resolvable resource identifiers, they don't expose anything an attacker could act on, and showing them makes this document easier to cross-reference against the code in [`../isolated-media-validator/`](../isolated-media-validator/).

## Verifying this yourself

If you have viewer access to the project (or are speaking with someone who does), the bucket-level IAM Condition above can be read directly with:

```sh
gcloud storage buckets get-iam-policy gs://YOUR_BUCKET_NAME --format=json
```

The Cloud Run service's authentication setting and attached service account can be checked with:

```sh
gcloud run services describe sas-transcriber-media-validator \
  --region=europe-west3 \
  --format="yaml(spec.template.spec.serviceAccountName, metadata.annotations)"
```

We are not able to grant external read access to our own project, for the same reasons stated in [`gcp-organization-policy.md`](./gcp-organization-policy.md). If you believe any value here is stale, please see the main [README](../README.md#reporting-a-discrepancy).
