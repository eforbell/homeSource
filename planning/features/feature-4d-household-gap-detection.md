# Feature #4D: Household Gap Detection + Life Events

Date: 2026-05-02
Parent feature: `feature-4-magic-insight.md`
Depends on: Feature #4A; benefits from 4C MagicLinks
Status: Defer until foundation is proven

## Purpose

Use optional family profile data plus existing document inventory to surface bigger-picture household issues: missing expected documents, coverage gaps, and age/life milestones.

## Why Later

This is the highest-value but also highest-hallucination part of MagicInsight. It should wait until the app has:

1. trusted MagicData review workflow
2. good document quality signals
3. related-document graph primitives
4. clear private-provider gating

## Local Model Gate

Household gap detection is blocked on `feature-4-0-local-model-readiness.md`. A 4B local model is acceptable if it proves conservative `no_insight` behavior, source-document grounding, and schema-valid output. If it only partially passes, keep 4D disabled and limit LLM use to single-document or MagicLink suggestions.

## Scope

### In

- optional DOB and legal name profile fields
- deterministic life event scanner
- local-private-provider-only gap detection scanner
- missing document and coverage gap MagicData

### Out

- kid-visible insights
- automatic external notifications
- legal/financial advice language
- cloud LLM execution by default

## Family Profile Schema

```sql
ALTER TABLE family_members ADD COLUMN IF NOT EXISTS date_of_birth DATE;
ALTER TABLE family_members ADD COLUMN IF NOT EXISTS legal_first_name TEXT;
ALTER TABLE family_members ADD COLUMN IF NOT EXISTS legal_middle_name TEXT;
ALTER TABLE family_members ADD COLUMN IF NOT EXISTS legal_last_name TEXT;
```

No SSN, no address, no medical details. Those stay in documents.

## Privacy Gate

LLM gap detection may summarize the household inventory. It must only run when:

- `MAGICINDEX_PROVIDER_PRIVATE=yes`, and
- provider is local/private (`ollama` or explicitly marked private compatible endpoint), or
- parent explicitly confirms cloud use in settings.

Default: if provider is not private, run deterministic life events only and disable LLM gap scan.

## Deterministic Life Events

Milestones:

- 18: adult docs, bank accounts, medical proxy considerations
- 21: optional adulthood milestone
- 26: dependent health insurance review
- 65: Medicare / retirement document review

Horizon: 12 months default.

Dedupe keys:

- `life_event:member:3:turning_18:2026-09-01`
- `life_event:member:2:turning_65:2027-01-12`

## LLM Gap Detection Prompt Inputs

Compact, structured summary only:

- family members: display/legal names, roles, DOB-derived ages
- document inventory by type/count/owner
- high-confidence MagicLinks summary if available
- key assets inferred from deterministic facts (vehicles/properties/accounts)

Do not send full document text for gap detection.

## Guardrails

- All gap results are `status='new'` suggestions.
- Titles must say "Suggested" or UI must badge them clearly.
- Required reasoning field.
- Confidence below 0.7 should be informational, not warning.
- Dismissed gaps should not return unless evidence changes materially.

## API/UI

Extend Insights page categories:

- Life Events
- Suggested Missing Documents
- Coverage Gaps

Settings/member profile:

- DOB
- legal first/middle/last
- privacy explainer

## Implementation Files

- migration extending `family_members`
- `lib/scanners/life-events.js`
- `lib/scanners/gap-detection.js`
- settings/member UI updates
- tests in `test/insights-life-events.test.js` and `test/insights-gap-detection.test.js`

## Acceptance Criteria

1. Parent can add/update DOB and legal names.
2. Member turning 18/26/65 within horizon creates a life_event insight.
3. LLM gap scan is disabled unless provider is private or explicitly allowed.
4. Vehicle title with no current insurance can create suggested missing_document/coverage_gap insight.
5. Dismissed gap does not reappear on simple rescan.
6. Tests pass.

## Language Boundary

MagicInsight is an organizer/advisor, not a lawyer/CPA/doctor. UI copy should say:

- "Suggested review"
- "Possible gap"
- "Consider uploading"

Avoid:

- "You are uninsured"
- "You must"
- legal/medical/financial determinations beyond document evidence.
