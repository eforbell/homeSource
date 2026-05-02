# Feature #4 MagicInsight — Ordered Delivery Index

Date: 2026-05-02
Parent concept: `feature-4-magic-insight.md`

## Why split the feature

MagicInsight is the right killer feature, but the full plan combines several products:

1. deterministic actionable dashboard insights
2. document quality and financial normalization
3. related-document graph
4. household gap/life-event reasoning

Shipping these as separate slices keeps each PR testable and lets the family use value immediately.

## Recommended Order

### 4.0 — Local Model Readiness Gate

Artifact: `feature-4-0-local-model-readiness.md`

Run in parallel with 4A or immediately before 4B. This proves the private LAN Qwen3 4B model can handle the specific MagicInsight jobs before we ask it to reason across household documents. It should not block deterministic 4A.

Why first/parallel:

- protects us from designing around a model that cannot reliably emit schema-valid insight candidates
- gives early evidence before investing in LLM-heavy 4B/4D work
- avoids prematurely requiring a larger 35B-class local model on constrained hardware

### 4A — MagicInsight Foundation

Artifact: `feature-4a-insight-foundation.md`

Ship first. Creates `magic_data`, deterministic expiry scanning, staleness, review workflow, and dashboard fix.

Why first:

- fixes the current noisy expiry dashboard
- no LLM dependency
- proves persisted insight UX
- establishes dedupe/idempotency model

### 4B — Quality + Amount Normalization

Artifact: `feature-4b-quality-amount-normalization.md`

Ship second. Makes MagicIndex more trustworthy and prepares financial summaries.

Why second:

- catches bad metadata before MagicInsight builds on it
- improves amount extraction from real documents like estimates/invoices
- generates useful document_quality insights

### 4C — MagicLinks

Artifact: `feature-4c-magic-links.md`

Ship third. Adds related document graph, starting with deterministic/manual links before LLM suggestions.

Why third:

- enables document-to-document navigation
- creates foundation for asset registry
- lower hallucination risk than gap detection

### 4D — Household Gap Detection + Life Events

Artifact: `feature-4d-household-gap-detection.md`

Ship fourth. Adds optional family profile, deterministic life events, and private-provider-gated LLM gap detection.

Why last:

- highest value but highest false-positive risk
- benefits from established MagicData review UX and MagicLinks evidence
- needs explicit privacy/provider gating

## Cross-Cutting Decisions

1. **Every generated item needs a dedupe key.** Re-scans must update, not spam.
2. **Confidence must be constrained to 0..1.** Enforce in DB and code.
3. **Insights are suggestions unless deterministic and obvious.** User review remains central.
4. **Cloud LLMs must not run household-level scans by default.** Require private provider or explicit confirmation.
5. **Prefer deterministic extraction from existing structured data before LLM.** LLM is for ambiguity, not date math.

## First PR target

Start with Feature 4A only, while also adding/running the 4.0 local-model readiness gate before any LLM-backed MagicInsight PR.

Minimum PR success definition:

- migration adds `magic_data`
- scanner creates future expiry alerts and ignores noisy historical expiries
- parent can accept/dismiss insights
- dashboard shows action-required insight count
- tests cover idempotency and kid denial
