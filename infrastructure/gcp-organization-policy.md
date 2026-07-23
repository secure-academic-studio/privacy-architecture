# GCP Organization Policy — EU-Only Resource Locations

Substantiates: [§2.2 Organisation-Level Resource Location Policy](https://secureacademic.com/gdpr-architectural-background/#sec-2-2)
Last verified against production: 2026-07-23

## What this is

Unlike every other file in this repository, this is not application code — it is an infrastructure control configured one layer *below* the application, at the Google Cloud **Organization** itself. It exists precisely because a safeguard living only inside `server.js` (see [`../gdpr-compliance-guard/startup-guard.js`](../gdpr-compliance-guard/startup-guard.js)) can in principle be bypassed by a misconfigured deployment, a new service added later, or a developer mistake. This policy closes that gap structurally: it is enforced by Google Cloud's own resource-management layer, before a non-compliant resource can ever be created — no application code runs at the point this constraint is evaluated.

## The constraint

| Field | Value |
|---|---|
| Constraint | `gcp.resourceLocations` ("Resource Location Restriction") |
| Applies to | The Google Cloud Organization (root level) |
| Policy source | Override parent's policy |
| Enforcement | Replace (ignore the parent's policy; use the rule below) |
| Rule | Allow `in:eu-locations` |

The "Policy source: Override" setting is a deliberate hardening choice, not a passive default — it means every project under the organization, including any created in the future, automatically inherits this constraint as `Policy source: Inherit parent's policy`. No project owner can opt out of it without organization-level administrative rights.

## What `in:eu-locations` actually resolves to

`in:eu-locations` is a Google-managed location group. Google, not this codebase, defines and maintains which physical regions belong to it, and it is re-evaluated by Google at the time each resource is provisioned. As of this writing it expands to the EU regions, zones, and multi-region aliases, including (non-exhaustively): `europe-west1`, `europe-west3`, `europe-west4`, `europe-west8`–`europe-west12`, `europe-north1`, `europe-north2`, `europe-central2`, `europe-southwest1`, the multi-region alias `eu`, and per-member-state groupings such as `de-locations` and `it-locations`.

Notably, the group correctly **excludes** European GCP locations that fall outside the EU: there is no `europe-west2` (London, UK) and no `europe-west6` (Zurich, Switzerland) anywhere in the allowed set. This is what makes the guarantee about genuine EU legal jurisdiction, rather than mere geographic proximity to Europe.

In practice, this means any attempt to provision a regionable resource (a storage bucket, for instance) outside an EU location fails at creation time, rejected by Google Cloud before the resource ever exists — independently of, and prior to, any application code. Even a hypothetical bug in the backend could not cause data to be stored outside the EU, because there is no non-EU location left available to provision.

## Bucket-level hardening (consistent with the constraint above)

The storage buckets used by the platform are additionally configured with:

- **Location:** multi-region `eu`.
- **Uniform bucket-level access:** enabled (no per-object ACL exceptions).
- **Public access prevention:** enabled — the buckets are never publicly reachable, regardless of any individual object's ACL.
- **Customer-supplied encryption keys (CSEK):** explicitly restricted on the bucket used for audio processing, leaving only Google-managed or Cloud KMS-managed keys as permitted encryption options. This removes the operational risk of a lost or mismanaged externally supplied key.

## Verifying this yourself

If you have viewer access to the organization (or are speaking with someone who does), the constraint above can be read directly with:

```sh
gcloud resource-manager org-policies describe gcp.resourceLocations \
  --organization=YOUR_ORG_ID \
  --effective
```

The bucket-level settings can be checked per bucket with:

```sh
gcloud storage buckets describe gs://YOUR_BUCKET_NAME \
  --format="yaml(location, uniform_bucket_level_access, public_access_prevention)"
```

We are not able to grant external read access to our own organization for obvious security reasons — this document is a faithful transcription of the current configuration, offered so that the *shape* and *mechanism* of the guarantee is checkable even without direct console access. If you believe any value here is stale, please see the main [README](../README.md#reporting-a-discrepancy).

## Why this matters

This is one of the clearest illustrations of "privacy by design, not by policy document" available on the platform: the EU-only guarantee does not rest on a promise, a contractual clause, or solely on application code — it is enforced structurally by the cloud provider's own access-control layer, at the level of the entire organization, and cascades automatically to every current and future project beneath it.
