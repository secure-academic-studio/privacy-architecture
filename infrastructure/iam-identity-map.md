# Least-Privilege Identity Map — Who Can Read What

Substantiates: [§2.6 Least-Privilege Identity Map](https://secureacademic.com/gdpr-architectural-background/#sec-2-6)
Last verified against production: 2026-10-17

## What this is

A claim such as "the backend cannot read your audio or text" is only as strong as the permissions the backend holds. This document names each identity involved in the Transcriber and the Proofreader, the role it holds, and the object prefixes that role is limited to. It is the checkable counterpart of the table in §2.6 of the architecture document.

Service-account e-mail addresses are not listed: they contain the GCP project ID, which this repository does not publish (see [What this repository is not](../README.md#what-this-repository-is-not)). Project-level roles of the worker identities are not listed either. The table lists the permissions relevant to the applications covered by the architecture document.

## The identities

| Identity | Permissions | Scope (IAM Condition) |
|---|---|---|
| **Main backend** (JSON key held as a deployment secret) | Custom role `sauVpsObjectWriteDelete`: `storage.objects.create`, `storage.objects.delete` (no read, no list) | prefixes `pending/`, `proofread_pending/`, `results/` |
| | `roles/storage.objectViewer` | status markers (`status/`) |
| | `roles/aiplatform.user` (project) | Vertex AI calls of the converters |
| | `roles/iam.serviceAccountTokenCreator` | only on the three invoker identities below (resource level) |
| **Transcriber worker** | Storage Object User | `pending/`, `results/`, `status/` |
| **Proofreader worker** | Storage Object User | `proofread_pending/`, `results/proofread_`, `status/proofread_` |
| **Media validator** | Storage Object Viewer | `pending/` only |
| **Three invoker identities** | `roles/run.invoker` on one Cloud Run service each | no storage access |

What the table means in practice: the backend can create and delete upload and result objects, so it can issue upload URLs and run the deletion layers. It holds no permission to read audio, document text or results. The one thing it reads is content-free status markers (job state, error category, token counts).

The prefix restrictions are IAM Conditions, evaluated by Cloud Storage at request time, in the same form as the one shown in [`media-validator-iam.md`](./media-validator-iam.md).

## Keys

- The workers, the validator and the invoker identities run as identities attached to their Cloud Run services. They hold no keys.
- An enforced organisation policy, `iam.managed.disableServiceAccountKeyCreation`, blocks the creation of new service-account keys.
- The backend identity is the single exception. It uses a JSON key, stored as a deployment secret. This is why the table says "JSON key held as a deployment secret" and not "no keys".
- The current key was issued on 2026-10-17, after the policy was enforced. To make that possible, the policy was suspended for the one project concerned for about four minutes (20:47–20:51 CEST) and restored immediately afterwards; no other project or identity was affected. The previous key, created before the policy was enforced, was disabled on 2026-10-17 and deleted on 2026-10-17.
- This is a replacement of the key, not the removal of the need for one: the backend still holds a JSON key.

## Audit logging

Cloud Storage data-access audit logging (admin read, data read, data write) is enabled on the project. Reads and writes of the bucket's objects are therefore recorded by Google Cloud, outside the application. It is enabled for Cloud Storage; it is not enabled project-wide for other services.

## What this does and does not claim

The design means that a leaked credential, a database or filesystem backup, or a copy of the backend's environment cannot read stored user material.

It does not make the backend irrelevant. A full compromise of the running backend could still misuse what it legitimately does: relay time-limited result-download URLs for job IDs it knows, create or delete objects within the permitted prefixes, spend Vertex AI quota, or alter the JavaScript served to browsers. The precise claim is "cannot read stored material", not "cannot be attacked".

A related disclosed limit: the old in-backend processing code still exists behind two environment flags, both unset in production. See [`../fail-closed-modes/`](../fail-closed-modes/).

## Verifying this yourself

With viewer access to the project (or in conversation with someone who has it), the bucket-level bindings and their conditions can be read with:

```sh
gcloud storage buckets get-iam-policy gs://YOUR_BUCKET_NAME --format=json
```

The permissions of the custom role can be read with the command below (use `--project` or `--organization`, depending on where the role is defined):

```sh
gcloud iam roles describe sauVpsObjectWriteDelete --project=YOUR_PROJECT_ID
```

The audit-log configuration can be read from the project's IAM policy:

```sh
gcloud projects get-iam-policy YOUR_PROJECT_ID --format=json
```

(look for `auditConfigs` with `service: storage.googleapis.com`).

We are not able to grant external read access to our own project, for the same reasons stated in [`gcp-organization-policy.md`](./gcp-organization-policy.md). If you believe any value here is stale, please see the main [README](../README.md#reporting-a-discrepancy).
