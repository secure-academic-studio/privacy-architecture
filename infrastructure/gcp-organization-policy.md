# GCP Organization Policy — EU-Only Resource Locations

Substantiates: [§2.2 Organisation-Level Resource Location Policy](https://secureacademic.com/gdpr-architectural-background/#sec-2-2)
Last verified against production: 2026-07-28

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

## Verification information (2026-07-28)

The two commands above were run against the live organization and the live storage bucket on 2026-07-28. Below is the command and its actual result — not a paraphrase, and not the full terminal session (login banner and shell prompt omitted).

```
$ gcloud resource-manager org-policies describe gcp.resourceLocations \
  --organization=1042350173656 \
  --effective
constraint: constraints/gcp.resourceLocations
listPolicy:
  allowedValues:
  - europe-southwest1-a
  - europe-west3-a
  - europe-west8-c
  - europe-west8-locations
  - eu-locations
  - europe-west1-d
  - europe-central2-c
  - europe-west3-b
  - it-locations
  - europe-west8-a
  - europe-southwest1-c
  - europe-central2-a
  - europe-west4-b
  - eur4
  - europe-west4-locations
  - europe-north2-a
  - europe-west12-locations
  - europe-west12-b
  - europe-west10-locations
  - de
  - europe-west8-b
  - de-locations
  - europe-west4
  - europe-west1-b
  - europe-west4-a
  - europe-west9-c
  - europe-north1-c
  - europe-west9
  - it
  - europe-west
  - europe-central2
  - europe-southwest1-b
  - europe-west12-a
  - europe-west10-a
  - europe-north1-b
  - europe-southwest1-locations
  - europe-west1
  - europe-west10-c
  - europe-west3-c
  - europe-north1-a
  - europe-west12
  - europe-west10
  - EU
  - europe-central2-b
  - europe-west10-b
  - europe-north2-c
  - eur3
  - europe-west1-c
  - europe-north2
  - europe-north2-b
  - europe-west9-a
  - europe-north1
  - eu
  - europe-west9-b
  - europe-north2-locations
  - europe-west1-locations
  - europe-west3-locations
  - europe-west9-locations
  - europe-southwest1
  - europe-north1-locations
  - europe-west3
  - eur8
  - europe-central2-locations
  - europe-west12-c
  - europe-west8
  - europe-west4-c
```

```
$ gcloud storage buckets describe gs://SECURE_ACADEMIC_STUDIO_BUCKET_NAME \
  --format="yaml(location, uniform_bucket_level_access, public_access_prevention)"
location: EU
public_access_prevention: enforced
uniform_bucket_level_access: true
```

The 66-entry allow-list above matches the region, zone, and multi-region family described under [The constraint](#the-constraint) — and, checked entry by entry, neither `europe-west2` (London) nor `europe-west6` (Zurich) appears anywhere in it, confirming the "correctly excludes" claim made above. The bucket output confirms `location: EU`, `uniform_bucket_level_access: true`, and `public_access_prevention: enforced`, matching the [bucket-level hardening](#bucket-level-hardening-consistent-with-the-constraint-above) section exactly.

The organization ID is shown as-is, since it is the organization's public identity rather than an infrastructure secret (see [README](../README.md#what-this-repository-is-not)). The bucket name is redacted to `SECURE_ACADEMIC_STUDIO_BUCKET_NAME`, consistent with this repository's placeholder policy for infrastructure identifiers — not because the name is otherwise secret; the signed-URL upload flow already exposes it to any browser DevTools session on the live site (see [`signed-url-flow/issue-upload-url.js`](../signed-url-flow/issue-upload-url.js)).

This remains self-reported: a reader still cannot re-run these commands themselves. It is, however, dated, exact, and directly checkable against Google's own public documentation of what `eu-locations` should contain.

## Why this matters

This is one of the clearest illustrations of "privacy by design, not by policy document" available on the platform: the EU-only guarantee does not rest on a promise, a contractual clause, or solely on application code — it is enforced structurally by the cloud provider's own access-control layer, at the level of the entire organization, and cascades automatically to every current and future project beneath it.
