# Idea: document type evolution from real-vault evidence

Date: 2026-05-02
Status: captured for follow-up, not a current schema change

## Why this note exists

HomeSource's current document types are good enough for MVP, but real household imports are surfacing a few missing top-level buckets that matter for browse/find workflows even if they are not academically perfect categories.

Current schema should remain stable while MagicIndex tuning continues, but we should record the strongest candidates and the prompt distinctions they imply.

## Strong candidates

### 1. `employment`

Why it matters:

- parents naturally want to browse "employment documents"
- many employment records currently get squeezed into `contract`, `legal`, or `other`
- tags like `salary`, `bonus`, `termination`, `benefits`, and `background-investigation` are useful detail, but they do not replace a durable top-level browse bucket

Likely examples:

- offer letters
- compensation notices
- relocation agreements
- severance / termination
- benefits and pension notices
- onboarding / background investigation forms

### 2. `invoice`

Why it matters:

- households store many contractor/vendor invoices that are not retail receipts
- "receipt" implies paid proof
- "invoice" implies amount due / billing request / payable record
- this distinction is operationally useful for future workflow and organization

Likely examples:

- HVAC invoice
- contractor billing statement
- appliance service invoice
- home repair invoice

## Real-vault evidence

### Facemyer invoice example

Observed behavior:

- model produced title: `Invoice`
- model classified document type as `insurance`
- confidence was still high enough to look plausible

Interpretation:

- this is not a random failure; it shows the model lacks a clean semantic landing zone between `receipt`, `contract`, and `other`
- users may store invoices precisely because they support future warranty/service/insurance claims, but that does **not** mean the document itself should be typed as `insurance`

## Recommendation for current phase

Do **not** expand the schema immediately just because a few categories are missing.

Instead:

1. keep current document types stable while 4B continues
2. strengthen prompt guidance so MagicIndex distinguishes:
   - receipt = proof of payment / completed purchase
   - invoice / bill / statement = payable or billing request
   - estimate / quote = proposed pricing before work
   - contract = agreement / terms
   - insurance = policy / coverage / claim language, not just future warranty relevance
3. continue collecting real-vault examples where the model repeatedly wants a missing category

## Threshold for change

Promote a new top-level type only when:

- it clearly improves browse/find behavior for parents
- it appears often enough in the vault to matter
- prompt tuning alone is not enough to prevent repeated misclassification

Current read:

- `employment` has likely crossed that threshold
- `invoice` is close and should keep being observed

## If/when implemented

Keep type hierarchy small:

- add `employment` first if we choose one near-term addition
- consider `invoice` next if contractor/vendor billing remains a repeated retrieval pattern

Tags should continue to carry finer meaning:

- `salary`, `bonus`, `termination`, `benefits`
- `HVAC`, `service_invoice`, `warranty`, `maintenance`

The type should answer "what main bucket is this?", while tags answer "what exact kind of thing is it?"
