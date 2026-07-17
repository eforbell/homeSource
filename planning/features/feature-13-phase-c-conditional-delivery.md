# Feature #13 Phase C — Conditional Delivery

Date: 2026-07-16
Last updated: 2026-07-17
Status: PRD draft; all decision gates attested and ready for implementation planning
Parent charter: `planning/features/feature-13-estate-continuity-phase-a.md`
Predecessor: `planning/features/feature-13-phase-b-the-letter.md`
Design source: `design/homesource-treatment.md`

## Outcome

Turn the Phase B `delivery_pending` handoff into a deliberate, auditable delivery
ceremony. Home Source should notify the designated trustees first, allow narrowly bounded
false-alarm intervention, then give each beneficiary or delivery-eligible trustee access
only to the encrypted letter and sealed documents already wrapped to that recipient's
active key.

Phase C is conditional delivery, not automatic decryption. Email contains no document
content or key material. The server never decrypts a document, never receives a private
key or plaintext DEK, and never grants a recipient a normal vault-browsing session.

## Phase boundary

### In scope

- Beneficiary email/contact onboarding and verification
- Redundant operator check-in reminders through email plus an onboarded `brrr` channel
- Preservation of the current safe recipient boundary: household kids and registered
  trustees may hold sealed wraps; parent-role members may not
- Trustee notification and bounded pause/false-alarm authority
- Explicit transitions out of Phase B `delivery_pending`
- Per-recipient delivery manifests covering the letter and eligible sealed documents
- Hashed, expiring, replaceable delivery and trustee-action tokens
- Recipient-scoped browser sessions and a no-navigation delivery landing page
- Delivery-time envelope/key/posture validation
- Client-side single-key unwrap and decrypt using the recipient's pre-registered key
- Durable delivery outbox, retries, audit, operations visibility, and backup coverage

### Explicitly out of scope

- Shamir splitting, threshold authorization, share aggregation, or quorum reconstruction
- Membership-change share redistribution or quorum re-wrapping
- Retrospective wrapping of a document after the operator becomes unavailable
- Automatic legal determination of death or incapacity
- General trustee accounts or normal trustee application sessions
- Recipient access to search, browse, tags, household metadata, or unrelated documents
- SMS, recipient push delivery, or third-party identity providers; `brrr` is limited to
  low-information operator check-in reminders in this phase
- Server-side document decryption or server-held plaintext key material

Quorum remains Phase D. Phase C should leave an authorization seam for Phase D to require
an additional threshold ceremony before activating a delivery grant, but no Phase D share
or threshold concepts should enter Phase C tables or endpoints prematurely.

### Controlled rollout assumption

Home Source has one private operator and will not be released to other households before
Phase C is complete. The production operator will not arm a Phase B switch, so Phase C does
not need a legacy-policy version, compatibility backfill, or migration path for previously
armed/delivery-pending switches. Deployment acceptance confirms there is no switch in an
armed-or-later active state before enabling the Phase C scheduler behavior; an unarmed draft
does not require compatibility handling. After Phase C lands, its complete
readiness and arming contract becomes the only supported production path.

## Shipped baseline

### Phase A

- Beneficiaries are `family_members`; trustees are external `vault_trustees` principals.
- Trustee invitation email, hashed registration token, passphrase/WebAuthn key ceremony,
  trustee-owned keys, and revocation are shipped.
- Envelope-v2 is authorization-canonical. `document_designations` is a rebuildable
  relational projection only.
- Sealed beneficiary/trustee holders are pre-wrapped while the operator is competent and
  excluded from normal document access.
- Phase A restricts household beneficiaries to `family_members.role = 'kid'`; a parent
  cannot be a sealed beneficiary because parents currently retain household-wide access.

### Phase B

- One owner-bound switch carries an encrypted authored letter, recipient identities,
  schedule, grace period, check-ins, and durable owner-reminder outbox.
- The scheduler advances only to `delivery_pending`, sends only an operator boundary
  notice, and leaves every sealed envelope holder unchanged.
- The switch recipient list and the designated-document matrix are separate today. The
  letter must contain a sealed holder for every switch recipient, but other sealed
  documents are not explicitly bound to the switch.
- The Letter is a first-class `documents` row (`document_type = legal`, `source_type =
  authored`, `metadata.continuity_letter = true`) referenced by the switch. It is hidden
  while staged and becomes an active encrypted vault record when armed; it is not stored in
  a parallel plaintext or letter-specific content table.
- The production state-advance and outbox timers are installed through Home Base.

### Phase B delivery gaps addressed by Phase C

1. `family_members` has no email/contact field or verification ceremony.
2. `continuity_recipients` stores identity and ordering, not a verified delivery channel.
3. Trustee registration proves control of the invitation address indirectly but does not
   record an explicit reusable contact-verification timestamp.
4. No transition consumes `delivery_pending`.
5. No recipient delivery grant, token, scoped session, manifest, or landing page exists.
6. Phase B defines no rule for whether the letter is delivered alone, with every sealed
   designation, or with an operator-curated subset; C13-4 selects a versioned explicit packet.
7. Feature #11 left revoked-holder recovery and already-stranded-document policy unresolved;
   C13-6 resolves both fail closed for online delivery.
8. Adult/spouse beneficiaries are named in the product treatment but cannot be represented
   safely by the current parent/kid authorization model. Phase C deliberately defers them;
   BugBase #142 tracks a future separation of family relationship from vault authority.
9. Generic document authorization lets every parent view active document/key-info records.
   A parent must not become a sealed recipient until key-info/envelope serving distinguishes
   the owning or currently authorized holder from a parent who merely has household-wide
   metadata visibility.
10. Phase B owner reminders are email-only. A continuity system should make deliberately
    redundant attempts to reach the operator without treating an insecure notification
    channel as proof of identity, liveness, or authority.

## Security and product invariants

1. **Envelope-canonical authorization.** A relational recipient/designation row never
   grants decryption access without a matching envelope holder.
2. **Pre-wrapped only.** Phase C cannot add or change a recipient wrap after escalation.
3. **Grant, do not globally unseal.** Delivery authority is represented by a scoped grant;
   Phase C does not rewrite the envelope holder or `document_designations.sealed` to make
   the document generally visible.
4. **Identity-bound serving.** A delivery grant may serve only the exact document file,
   envelope, and wrapped DEK associated with its recipient identity/key.
5. **No ambient session authority.** A normal family-member session alone cannot reveal a
   sealed operator document. A trustee never receives a normal application session.
6. **Content-free mail.** Email may identify Home Source and the intended action, but never
   includes titles, filenames, letter text, document contents, DEKs, private keys, or
   recovery material.
7. **Hashed tokens at rest.** Raw delivery/action tokens exist only in dispatcher/request
   memory, are purpose-bound, expire, are replaceable, and cannot create broader access.
8. **Fail closed on posture changes.** Revoked keys, missing wraps, inconsistent envelope
   projections, missing encrypted files, or identity mismatch block that delivery item.
9. **No silent partial authorization.** A recipient sees an explicit safe status when an
   item is unavailable; the system never substitutes a different holder or key.
10. **Phase D compatible, Phase D free.** Delivery-grant activation can later be gated by a
    threshold result, but Phase C implements only single-recipient-key authorization.
11. **Notification channels are insecure hints.** Email and `brrr` payloads are
    low-information, independently retryable prompts. A delivery receipt never proves the
    operator saw the message. Operator-reminder channel failure does not alter switch state;
    designated-trustee notification readiness follows the explicit fail-closed C13-2 gate.
12. **Arming requires operator-reachability evidence, not only transport health.** SMTP
    configuration tests and provider acceptance prove that Home Source can attempt delivery;
    they do not prove that the owning parent receives the configured destination. Before a
    switch may arm, the owner must acknowledge a purpose-bound, low-information challenge
    delivered through every channel enabled for that switch. This evidence is readiness
    attestation only and can never count as a check-in or other proof of continuing liveness.

## Proposed lifecycle

The lifecycle below reflects the attested recovery and trustee-window policies.

| Current state | Action/event | Proposed result | Authority |
|---|---|---|---|
| `delivery_pending` | Phase C preflight succeeds and eligible trustees exist | `trustee_notification_pending` | scheduler under switch lock; enqueue all trustee notices |
| `delivery_pending` | Phase C preflight succeeds and no trustees exist | `recipient_delivery` immediately | scheduler under switch lock |
| `delivery_pending` | Preflight finds a switch-wide policy/configuration failure that prevents a trustworthy run | `delivery_blocked` | scheduler; operator-visible only |
| `trustee_notification_pending` | Every designated trustee has at least one successful send | `trustee_window` with a fixed 72-hour deadline starting at the final required success | scheduler under delivery-run lock |
| `trustee_notification_pending` | Any required trustee notice reaches permanent failure | `trustee_notification_blocked` | outbox/scheduler; fail closed |
| `trustee_notification_blocked` | Bounded retry succeeds for every designated trustee | `trustee_window` with a fixed 72-hour deadline starting at the final required success | operator/outbox under delivery-run lock |
| `trustee_window` | First valid designated trustee pause token | `trustee_paused` with a fixed 30-day deadline measured from that action | one eligible trustee |
| `trustee_window` | 72-hour action window expires without a pause | `recipient_delivery` | scheduler |
| `trustee_paused` | Pause expires | `recipient_delivery` | scheduler |
| `delivery_pending` / `trustee_notification_pending` / `trustee_notification_blocked` / `trustee_window` / `trustee_paused` | Authenticated owner proves liveness | `armed` with a fresh cycle | owning parent + re-authentication |
| `recipient_delivery` | Per-recipient preflight fails | blocked recipient grant; other healthy recipients continue | scheduler under delivery-run lock |
| `recipient_delivery` | First healthy recipient grant activates at the approved atomic commit | `delivery_active` | scheduler/outbox transaction |
| `delivery_active` | All grants terminal or retention expires | `delivery_complete` | scheduler |

Trustee notification is not document access. A trustee pause token must not serve the
letter, documents, envelopes, or key material. If a trustee is also a delivery recipient,
that recipient gets a separate delivery grant only after the trustee window resolves.

## Delivery model

### Contact onboarding

The recommended model is a purpose-built verified contact table rather than adding an
unverified email directly to `family_members` or copying mutable email strings into every
switch.

Provisional entities:

- `member_contact_channels`
  - member FK, channel type (`email` in Phase C), normalized address
  - `pending` / `verified` / `revoked` status
  - verified/revoked timestamps and audit identity
- `member_contact_verification_tokens`
  - hashed, single-use, expiring token; replacement invalidates prior token
- A delivery grant stores an immutable normalized destination snapshot and the verified
  contact-row ID used at issuance so later address edits cannot redirect an issued grant.

The owning parent may initiate beneficiary contact setup, but the address should not become
delivery-eligible until the recipient proves control of it. Contact verification provides
no document access and no normal Home Source session.

Beneficiary contact verification should normally be combined with key onboarding/readiness
instead of creating a second ominous ceremony. The message voice is calm and preparatory:
the writer has asked the recipient to prepare secure access to a private family continuity
document. It must not imply that the writer is ill, missing, incapacitated, or dead, and it
must not reveal document titles or inheritance details.

### Delivery manifests

Each recipient receives a durable manifest created from a consistent delivery-time
preflight. Every item records:

- exact document ID and encrypted file ID
- recipient identity (`member_id` XOR `trustee_id`)
- exact envelope holder key ID and fingerprint
- designation/projection evidence used during preflight
- eligibility/block reason without plaintext metadata
- immutable switch cycle and delivery-run identity

The envelope remains canonical at serve time. The server rechecks the current document,
file, key, holder identity, fingerprint, sealed designation, and grant before returning any
encrypted artifact or wrapped DEK.

### Scoped recipient experience

- Email opens a dedicated delivery route with no app navigation or document browsing.
- Token validation creates, at most, a short-lived recipient-scoped delivery session bound
  to one grant and one recipient identity.
- The page lists grant items only as deterministic, non-semantic labels such as
  `Private document 1`, `Private document 2`, and so on. The Letter receives no special
  pre-unlock label. Ordinals come from the immutable manifest order and never from title,
  filename, type, description, tag, or other vault metadata.
- Recipient-scoped list responses omit server-side document titles, filenames, descriptions,
  types, tags, owner names, and continuity-specific meaning. After local decryption, the UI
  may show a filename or description only when it came from metadata encrypted inside that
  artifact; the generic manifest label remains the stable item identifier.
- The browser fetches only the recipient's encrypted private-key material and holder-local
  wrapped DEK, performs passphrase or WebAuthn PRF unwrap locally, then decrypts the selected
  encrypted file locally.
- A beneficiary's existing household login may help prove identity, but it cannot replace
  the delivery grant or expand its scope.

## Proposed durable data model

Names are provisional; migrations must be additive and backup-covered.

1. `member_contact_channels`
   - verified beneficiary delivery addresses without changing suite-wide member identity
2. `trustee_contact_channels`
   - reusable verified trustee destinations, separate from invitation history
3. `member_contact_verification_tokens`
   - hashed email-control ceremony tokens
4. `continuity_packet_versions`, `continuity_packet_documents`,
   `continuity_packet_recipients`, and `continuity_packet_recipient_documents`
   - immutable staged/active packet policy, roster, document scope, and coverage matrix
5. `continuity_switch_trustees`
   - witness/pause designation independent from packet delivery eligibility
6. `continuity_delivery_runs`
   - one run per switch/cycle; trustee deadline, pause state, release time, terminal status
7. `continuity_delivery_grants`
   - one recipient-specific grant; member/trustee XOR identity, destination snapshot,
     status, expiry/retention, notification state
8. `continuity_delivery_items`
   - grant-to-document manifest with exact holder key/fingerprint and eligibility status
9. `continuity_trustee_action_tokens`, `continuity_delivery_tokens`, and
   `continuity_delivery_sessions`
   - separate hashed pause, access-link, and scoped-session bearer material
10. `member_notification_channels`
   - write-only operator `brrr` target plus enabled/tested readiness state
11. `continuity_operator_channel_attestations`
   - switch/owner/channel/config-version-bound reachability challenges and acknowledgements;
     raw challenge values are hashed and target secrets are not copied into the row
12. Existing `continuity_events`, `continuity_notification_outbox`, scheduler runs, and audit
   log are extended rather than replaced.

Recommended constraints:

- unique delivery run per switch + schedule cycle
- unique grant per run + recipient identity
- unique item per grant + document
- identity XOR checks for every polymorphic recipient reference
- one usable delivery token per grant/purpose and one usable trustee-action token per
  run/designated-trustee/purpose
- explicit closed-set statuses and purpose values
- no plaintext letter/document metadata in events, outbox, tokens, or contact-token rows

## Delivery-time preflight

Preflight runs under a delivery-run/switch lock and is repeatable. For every intended
recipient and document it verifies:

1. recipient identity still exists and remains eligible
2. delivery contact is verified and active
3. encrypted document/file exists and is readable by the service account
4. envelope version/mode is supported
5. exactly one matching holder identity/key/fingerprint exists for that recipient
6. holder remains sealed for the continuity trigger
7. referenced key exists, is active, and belongs to the intended identity
8. relational designation projection matches the envelope
9. document is not archived/replaced in a way that invalidates the grant
10. the letter and selected sealed-document scope match the attested Phase C policy

Preflight never unwraps a DEK. Results are durable and content-minimal so repeated scheduler
runs cannot generate a different grant silently.

## Notifications and tokens

- Reuse the Phase B durable outbox, leases, retry classification, deterministic message-ID,
  and raw-token-at-claim pattern.
- Generalize notification attempts so email and `brrr` are independently deduped and retried;
  one logical owner reminder may create one attempt per configured channel.
- Keep transport tests distinct from operator-reachability challenges. Transport tests record
  whether the application/provider accepted an attempt; reachability challenges require the
  authenticated owning parent to acknowledge receipt from the destination being tested.
- Reachability challenge tokens are hashed, single-use, short-lived, bound to switch draft,
  owner, channel, and channel configuration version, and grant no check-in or document access.
- Add content-minimal notification types for trustee verification, trustee pause outcome,
  recipient delivery, token replacement, blocked delivery, and operator recovery.
- Trustee notification completion is evaluated per designated trustee. The common action
  deadline is stored only when every trustee has a successful send; provider failure cannot
  silently consume a trustee's action window or release beneficiary grants.
- Trustee/action and recipient/access tokens use separate purposes and routes.
- Retrying a recipient email replaces the prior usable access token; only the newest link
  works.
- An active recipient grant remains reissuable for one year from grant activation. A
  rate-limited self-service request may send a replacement only to the immutable verified
  address snapshotted into that grant; the response is uniform and never confirms whether a
  grant, recipient, or address exists.
- Reissue never changes the one-year grant deadline. At that deadline, all unused links and
  scoped sessions become terminally expired for online delivery.
- Rate limiting is route- and purpose-specific. Invalid, expired, replaced, wrong-recipient,
  and unavailable grants return uniform responses.
- A token must not be embedded in logs, audit details, scheduler errors, or backup exports.

## UI surfaces

### Operator

- Continuity directory shows beneficiary contact state separately from key state.
- Settings/Continuity provides operator `brrr` onboarding with masked readback,
  enable/disable, clear, last-test status, and a low-information test notification.
- Arming readiness shows transport-test state separately from owner-reachability state for
  every selected channel, and provides a single ceremony to send and acknowledge each
  channel's low-information challenge.
- Switch setup/readiness distinguishes: verified contact, active key, sealed letter wrap,
  and sealed-document count.
- Delivery status shows trustee window, pause deadline, blocked recipients/items, outbox
  health, and operator recovery action without revealing token values.
- Any owner recovery from an escalated state requires same-request re-authentication.

### Trustee

- Dedicated content-free verification page: identify the household/operator safely, explain
  the limited action, and allow one bounded pause if authorized.
- No document list, letter, filenames, envelope details, or normal app session.

### Recipient

- Dedicated delivery doorway with no sidebar/nav/search.
- Pre-unlock items use only `Private document N`; the Letter is not distinguished by name or
  position-derived semantics.
- Clear key-selection/unlock ceremony using existing passphrase/WebAuthn browser primitives.
- Per-item safe status for ready, locally unlocked, expired, or blocked.
- No automatic bulk decryption and no plaintext persistence in browser storage.

## API surface sketch

Exact paths remain provisional.

### Authenticated operator

- beneficiary contact create/resend/revoke/status
- operator `brrr` target save/enable/disable/clear/test and readiness status
- delivery readiness/preflight preview
- escalated owner-liveness recovery with re-authentication
- delivery run/grant/outbox operations status and bounded retry

### Sessionless contact/trustee ceremonies

- validate/consume beneficiary contact-verification token
- validate/consume trustee pause token
- no normal app session issuance

### Recipient-scoped delivery

- validate/consume delivery token and create short-lived scoped grant session
- request a replacement link for an active grant without changing its destination or
  one-year deadline
- list exact grant items
- fetch exact encrypted file/envelope/key material for the grant recipient
- record local-open outcome without claiming server-side decryption proof
- revoke/expire scoped session

Every mutation uses a bounded operation key and a durable dedupe event.

## Decision gates requiring attestation

### C13-1 — Beneficiary population and adult/spouse support

Current code safely supports household kids and registered trustees as sealed holders.
Although the writer's broader intent is to select named kin expected to outlive them, a
`family_members.role = 'parent'` identity currently has ambient administrative access to all
active documents, key-info/envelopes, encrypted files, and generic designation mutations.
Giving that same identity a sealed holder-local DEK wrap would make the pre-trigger seal a UI
convention rather than a server-enforced access boundary.

- **Option A:** Phase C v1 remains household-kid beneficiaries only; adult/spouse support is
  a separate identity/role project.
- **Option B:** Add a non-parent adult beneficiary principal/role in Phase C, with no ambient
  household-wide document access.
- **Option C:** Redesign parent authorization so a second parent can be a sealed beneficiary;
  broadest and highest-risk option.

**Decision:** Option A. Phase C keeps household kids and registered trustees as the only
sealed-recipient principal types. Parent-role members cannot receive a sealed Letter or
continuity-packet wrap and must not be duplicated as shadow trustees to evade that boundary.

Continuity administration boundary:

- the switch owner/vault operator may create, replace, remove, and deliver continuity seals
- another parent-role session must not administer the owner's Letter or continuity-packet
  designations merely because generic `requireParent` authorization succeeds
- generic seal/unseal and envelope-serving routes must recognize continuity-owned records and
  enforce switch-owner or active delivery-grant authority as appropriate
- this owner scoping is defense in depth for kids/trustees and does not make parent-role
  adults eligible recipients in Phase C

Future consideration: adult/spouse beneficiaries require a separate non-administrative adult
family principal or an explicit `vault_operator` capability separated from family relationship.
BugBase #142 preserves that work; it is not a Phase C dependency or invitation to weaken the
current seal boundary.

Intent confirmed: Phase C sealed recipients remain household kids and registered trustees;
parent-role adult recipient support is deferred. Eric M. Forbell, 2026-07-17.

### C13-2 — Trustee window and pause authority

- Which designated trustees are notified: all, first in order, or one explicitly selected?
- Can any notified trustee pause, or only a primary trustee?
- Is pause fixed at 30 days, configurable, or bounded within a range?
- Is one pause allowed per delivery run, or can multiple trustees extend it repeatedly?
- If no trustee is designated, does the same fixed safety window elapse before beneficiary
  release, or may delivery proceed immediately?

**Decided authority shape:** trustees are a flat peer set. The writer may designate zero or
more trustees; all eligible designated trustees are notified concurrently. There is no
primary trustee, hierarchy, notification order, tie-breaking rank, or superior trustee
authority. Each trustee receives an identity-bound token carrying the same limited action
set, and trustees cannot cancel or access documents through that token.

**Decision:** one successful pause total per delivery run, shared by the trustee peer set and
fixed at 30 days. The first valid pause wins under a delivery-run lock. Later concurrent or
replayed trustee attempts return the already-established deadline and cannot extend, stack,
or restart the pause. If no trustee is designated, beneficiary delivery begins immediately
after the configured Phase B grace period; Phase C adds no artificial trustee window when no
trustee exists.

When one or more eligible trustees are designated, Phase C creates a fixed 72-hour trustee
action window after the Phase B grace period. All eligible trustees are notified concurrently,
but the common 72-hour deadline begins only after every designated trustee has at least one
successful notification send. A permanent failure blocks trustee-window activation and all
beneficiary grants until bounded retry succeeds for every trustee. If none acts before the
deadline, recipient delivery begins. If the first valid trustee acts, the 72-hour window closes
and one fixed 30-day pause begins from that successful action. No later trustee action may
extend either deadline.

Intent confirmed: multiple trustees are permitted but have equal standing with no hierarchy.
One shared 30-day pause is permitted per delivery run. With no trustee, there is no additional
post-grace wait. With trustees, the action window is fixed at 72 hours. Eric M. Forbell,
2026-07-17.

Notification policy confirmed: all designated trustees must each have at least one successful
send before the common 72-hour window starts. Permanent notification failure blocks recipient
delivery until successful retry. Eric M. Forbell, 2026-07-17.

### C13-3 — Owner recovery after `delivery_pending`

- **Option A:** owning parent may prove liveness and return the switch to `armed` with a fresh
  cycle until recipient delivery grants are activated.
- **Option B:** owning parent may only cancel the switch after escalation.
- **Option C:** no online reversal; operator intervention is required.

**Recommendation:** Option A before grant activation, requiring current passphrase and an
explicit warning. Once a recipient grant is activated, online reversal cannot retract
already-delivered ciphertext and must not claim otherwise.

Attest: Option A - Eric M. Forbell, 2026-07-17

**Approved activation boundary:** activation is the successful commit of one database
transaction containing the immutable recipient grant and manifest, the usable access-token
hash, and its recipient-notification outbox entry. Owner recovery is no longer permitted
after that commit. It does not wait for provider acceptance, successful email delivery, link
consumption, session creation, or local decryption. A dispatcher crash or notification
failure after commit retries delivery and may replace the usable token, but cannot restore
owner-recovery authority or extend the one-year grant deadline. This database-first boundary
prevents an external notification side effect from racing a purported recovery.

Intent confirmed: the atomic database commit is the irreversible grant-activation boundary.
Eric M. Forbell, 2026-07-17.

### C13-4 — Which sealed documents are delivered

- **Option A:** letter plus every active document currently sealed to that recipient.
- **Option B:** letter plus an explicit operator-curated switch document set frozen at arm or
  replacement time.
- **Option C:** letter only; it instructs recipients how to pursue other documents later.

**Decision:** Option B. The writer maintains an explicit continuity packet containing the
Letter plus selected sealed documents. Packet membership and recipient coverage are reviewed
during every re-seal ceremony because Phase B currently binds only the Letter.

Intent confirmed: explicit continuity packet. Eric M. Forbell, 2026-07-16.

### C13-5 — Beneficiary email ownership and verification

- **Option A:** parent enters address; beneficiary must verify control before it is eligible.
- **Option B:** beneficiary enters address while authenticated as their household member.
- **Option C:** parent-entered address is trusted without recipient verification.

**Decision:** support A and B, but never C. The writer may initiate onboarding by selecting
the named family member and entering an address; the recipient proves control of that address
through a one-time link. When the recipient does not already have a ready active key, the same
calm ceremony continues into key registration and a test-unlock/readiness confirmation.

Ceremony requirements:

- token is bound to the intended `member_id`, normalized email, purpose, and expiry
- consuming the link verifies the address but grants no document access
- an existing verified/ready key may be confirmed rather than replaced
- an email change invalidates prior verification and unused delivery tokens for that address
- readiness requires both verified contact and at least one active tested recipient key
- copy remains subtle and preparatory, with no death, incapacity, missed-check-in, document
  title, or inheritance-detail language

Intent confirmed: recipient verification is required when presented as a neutral key/readiness
onboarding ceremony. Eric M. Forbell, 2026-07-16.

### C13-6 — Revoked and stranded key policy

This resolves Feature #11 hardening open decisions #5/#6 for online continuity delivery.

- **Option A:** fail closed; never expose revoked key material online; block affected items;
  rely on separately documented offline backup recovery if available.
- **Option B:** add a controlled online recovery-mode endpoint for revoked key material.
- **Option C:** permit manual database intervention as the supported path.

**Recommendation:** Option A for Phase C. Online delivery is the wrong place to weaken
revocation semantics. Healthy recipient grants may proceed, but under C13-9 any blocked item
blocks that recipient's entire attested packet. The blocked outcome is explicit, audited, and
never substituted with another identity/key.

Attest: Option A - Eric M. Forbell, 2026-07-17

### C13-7 — Delivery-link and scoped-session lifetime

**Decision:** each emailed delivery link expires after seven days and is replaced whenever a
new link is issued. Consuming a link creates a recipient-scoped browser session lasting no
more than 60 minutes. The underlying delivery grant remains active for one year from its
activation timestamp.

While the grant is active, the recipient may use a rate-limited self-service flow to request
a replacement link. Home Source sends it only to the immutable verified address snapshotted
when the grant was issued; the request cannot supply or redirect to another destination and
returns a uniform response that does not disclose grant/address existence. Reissue invalidates
the prior usable link but never extends the one-year deadline.

At the one-year deadline, the grant, unused links, and scoped sessions become terminally
expired for online delivery. Expiry does not claim to revoke ciphertext or plaintext already
downloaded and does not delete encrypted continuity artifacts retained under backup policy.

Intent confirmed: seven-day replaceable links, 60-minute scoped sessions, one-year grant
availability, and verified-address-only self-service reissue. Eric M. Forbell, 2026-07-17.

### C13-8 — Trustee document eligibility

Trustees are witnesses first, but some may also hold designated document wraps.

- **Option A:** trustee notification grants pause authority only; trustees never receive
  documents in Phase C.
- **Option B:** a trustee may receive a separate delivery grant after the trustee window only
  for documents explicitly selected for that trustee.

**Recommendation:** Option B, keeping pause and delivery tokens completely separate.

Attest: Option B - Eric M. Forbell, 2026-07-17

### C13-9 — Delivery atomicity when one item or recipient is blocked

- **Option A:** all-or-nothing per switch; one blocked recipient/item blocks every delivery.
- **Option B:** atomic per recipient; one recipient proceeds only when that recipient's full
  attested manifest is ready, while another blocked recipient does not stop healthy grants.
- **Option C:** partial per item; deliver each healthy document even when another item in the
  same recipient manifest is blocked.

**Recommendation:** Option B. It avoids household-wide blockage while ensuring each recipient
gets the complete packet the operator explicitly approved, rather than an unexplained subset.

Attest: Option B - Eric M. Forbell, 2026-07-17

### C13-10 — Writer edits, family changes, and recipient-roster versioning

The writer expects to refine or augment the Letter and its named recipient set over time,
including after a death, divorce, changed relationship, address change, or key replacement.
The active delivery plan therefore cannot be an append-only list that silently retains every
historic recipient wrap.

Settled requirements:

- edits while `armed` or `paused` use an explicit owner-authenticated re-seal ceremony
- the new Letter ciphertext, named recipient roster, verified contacts, envelope wraps, and
  delivery document scope become active atomically; failure preserves the prior version
- removed recipients are absent from the new Letter envelope and cannot receive future
  delivery tokens
- prior letter versions are archived for operator recovery/audit but never become selectable
  by a future delivery grant
- changes after escalation require successful owner recovery back to `armed`
- no system can retract ciphertext already delivered before a later divorce/removal; the UI
  and audit language must state this honestly

Scope alternatives considered:

- **Option A:** roster changes update the Letter only; other sealed documents are managed
  independently in the designation matrix.
- **Option B:** roster changes update the Letter and the explicit Phase C delivery bundle,
  with a review/rewrap step for every affected document.
- **Option C:** removing kin automatically removes that holder from every document in the
  vault, including documents outside the switch delivery scope.

**Decision:** Option B. Removing a beneficiary from the named roster must update the Letter
and every document in the explicit continuity packet. The replacement packet becomes active
only when that beneficiary's holder wrap and designation have been removed from every packet
document and all remaining recipient envelopes validate.

Packet-wide removal semantics:

- stage the revised Letter, roster, packet manifest, and every affected envelope mutation
  before changing the active switch version
- commit all database envelope/projection changes under document locks in one bounded
  operation; failure on one packet document preserves the entire prior active packet
- invalidate the removed beneficiary's unused delivery tokens, scoped sessions, grants, and
  queued notifications
- prevent future envelope/key serving for the removed identity across every packet item
- do not alter unrelated documents outside the explicit packet
- state honestly that ciphertext or plaintext already obtained before removal cannot be
  recalled; removal blocks future Home Source authorization, not copies already possessed

Intent confirmed: removed beneficiaries lose future access across all continuity-packet
documents. Eric M. Forbell, 2026-07-16.

### C13-11 — Redundant operator reminders through `brrr`

The estate owner should receive intentionally over-and-beyond check-in outreach rather than
relying on email alone. Home Source will onboard an operator-specific `brrr` target using the
Family Pulse pattern and adopt Helm's fail-soft, cooldown, and sanitized-delivery logging.

Settled requirements:

- zero or one enabled `brrr` target per parent/operator in v1
- target secret or full webhook URL is write-only, returned only as a mask, and never logged
- parent can add, replace, enable, disable, clear, and test their channel
- continuity reminders attempt email and enabled `brrr` independently for approaching, due,
  overdue, and delivery-boundary owner events
- each channel has its own durable attempt/dedupe/result state; success or failure on one does
  not suppress the other or alter the continuity transition
- payloads assume the push provider, notification preview, and device lock screen are
  insecure: no names beyond generic Home Source branding, no missed-check-in dates, switch
  status, cadence, trustee/beneficiary identity, document title, letter text, or token
- recommended payload: title `Home Source`; message `A private Home Source check-in needs
  your attention.`
- `brrr` opens the authenticated Home Source Continuity page and does not carry a raw
  single-use check-in or delivery token; email retains the existing purpose-bound check-in
  link
- network failures are bounded, classified, retryable, and never crash the scheduler/outbox
- app-level backup export redacts/omits the reusable target secret and restores the channel
  disabled, requiring operator re-onboarding; full database-admin backups remain an explicit
  infrastructure-secret boundary

Proposed storage follows the suite pattern:

- `member_notification_channels`: member FK, `channel_type = 'brrr'`, label, write-only
  target secret, enabled/tested state, timestamps, unique member/channel
- either generalize the continuity outbox with a channel type and channel reference or add a
  sibling channel-attempt table; never copy the `brrr` secret into outbox/event/audit rows
- delivery logs store only sanitized low-information payloads and safe error classes

Readiness alternatives considered:

- **Option A:** email is mandatory and `brrr` is optional; every channel selected by the
  operator must prove both transport function and owner reachability before arming.
- **Option B:** every installation must configure and prove both email and `brrr` before
  arming, regardless of operator preference.

**Decision:** Option A. Email remains the baseline because it carries the existing
purpose-bound check-in and future delivery links. `brrr` is a strongly recommended but
operator-optional second channel; Home Source must not impose one household's preferred
channel mix on other operators. However, every channel an operator elects to enable for the
switch must pass both transport verification and an operator-reachability gate before the
switch can arm.

Readiness requirements:

- SMTP configuration verification, a successful test send, or provider acceptance is a
  transport-health signal only; none proves the owner received the message
- the arming ceremony sends a distinct low-information challenge to baseline email and every
  optional channel selected for continuity outreach
- each challenge acknowledgement requires an authenticated owning-parent session and is
  bound to the switch draft, owner, channel type, and masked target/configuration version;
  acknowledging it cannot check in, arm the switch by itself, or grant document access
- arming requires a current acknowledgement for baseline email and every optional channel
  enabled on that switch; an operator who cannot verify optional `brrr` may explicitly disable
  it and proceed with the verified email baseline after the UI clearly reports the reduced
  redundancy
- successful arming records an immutable, secret-free snapshot of selected channels, target
  fingerprints/configuration versions, transport-test state, acknowledgement timestamps, and
  the owning parent's arming attestation
- changing an address, target, relevant SMTP configuration, or channel enablement invalidates
  its reachability evidence for the next arm/re-arm ceremony; it does not retroactively erase
  the evidence attached to a prior arming event
- readiness shows transport status, last real delivery result, reachability acknowledgement,
  target-change invalidation, and safe failure state as separate signals
- once armed, a later channel outage is visible and retryable but does not silently disarm
  or change continuity state
- the channel-attempt model remains extensible so future operators can choose a different
  optional second channel without changing the core switch lifecycle

Intent confirmed: second-channel redundancy is preferred but not mandatory. Transport
configuration alone is insufficient: arming must preserve evidence that the owning parent
actually acknowledged a challenge through every channel they enabled for continuity alerts.
Eric M. Forbell, 2026-07-16.

## Implementation contracts resolving readiness review

The remaining readiness findings are architecture contracts derived from the attested product
decisions. They do not introduce additional operator choices.

### Trustee witness authority is separate from delivery eligibility

- A switch-level trustee designation grants only notification and the one shared pause action.
- A packet-version recipient row grants no pause authority; it only records that an eligible
  kid or registered trustee is intended to receive explicitly wrapped packet documents.
- A designated trustee may therefore be witness-only or both witness and packet recipient.
  Merely registering a `vault_trustees` principal grants neither role.
- Pause/action tokens bind to delivery run + switch-trustee designation. Recipient-access
  tokens bind to a delivery grant. The two token subjects, routes, and purposes never overlap.
- Add a reusable verified trustee contact row, parallel to member contacts. Successful trustee
  registration may seed it as verified for the invitation address; later address replacement
  requires a new control-verification ceremony and invalidates readiness.

### Packet and roster versions are durable

Add an immutable versioned policy model rather than mutating the current recipient list in
place:

- `continuity_packet_versions`: switch/version, staged/active/superseded status, Letter
  document, creator, timestamps, and activation attestation
- `continuity_packet_documents`: exact document/file membership and deterministic safe order
- `continuity_packet_recipients`: member/trustee XOR intended-delivery identity
- `continuity_packet_recipient_documents`: explicit recipient/document coverage and expected
  holder key/fingerprint evidence
- `continuity_switch_trustees`: independent witness/pause designations

One owner-authenticated re-seal transaction validates and activates the complete staged packet
version, then supersedes the prior version. A delivery run binds permanently to exactly one
active packet version and never reconstructs its roster or scope from mutable current rows.
The existing `continuity_recipients` representation is migrated into this model only for
unarmed drafts under the controlled-rollout rule; no armed legacy policy is inferred.

### Blocking is evaluated at the correct scope

- Switch/run-wide `delivery_blocked` is reserved for failures that prevent a trustworthy run
  from being constructed at all, such as no active attested packet version or corrupted
  switch-level policy.
- Recipient or item posture failures create a blocked recipient grant with content-minimal
  reasons. Because delivery is atomic per recipient, one blocked item blocks that recipient's
  whole grant, not the healthy grants of other recipients.
- A run may be partially active: healthy grants activate and notify while blocked grants remain
  operator-visible and fail closed. The switch reaches `delivery_complete` only after every
  grant is terminal under its applicable retention/recovery policy.

### Tokens and scoped sessions are separately persistent

- `continuity_trustee_action_tokens` stores hashed, single-use tokens bound to delivery run +
  designated trustee + action purpose; it does not require or reference a delivery grant.
- `continuity_delivery_tokens` stores hashed, replaceable recipient-access tokens bound to one
  grant. A partial unique constraint permits only one currently usable token per grant/purpose.
- `continuity_delivery_sessions` stores only a hash of the browser bearer value plus grant,
  recipient, creation, expiry, revocation, and bounded activity timestamps. Sessions are
  independently revocable and cannot outlive their grant.
- Raw token/session values exist only in request or dispatcher memory and never in durable
  outbox payloads, logs, audits, events, or backups.

### Continuity authorization uses a complete route matrix

Before implementation is accepted, inventory and test every generic route that can expose or
mutate a continuity Letter, continuity-specific holder wrap, packet policy, or active grant:

- list/detail/search metadata and authored-document routes
- key-info, envelope, holder mutation, seal/unseal, and designation routes
- encrypted-file fetch/download and local-unlock bootstrap routes
- archive/delete/replace, sharing, import/export, and backup/restore routes

All such routes use one shared continuity-aware authorization resolver. Only the switch owner
may administer the Letter, packet versions, or continuity seals before escalation; only an
active exact-item delivery grant may serve a sealed recipient wrap afterward. Selecting an
otherwise ordinary document for a packet does not erase access independently granted by its
normal vault policy, but generic parent authorization must never expose a continuity-specific
sealed wrap or bypass the grant boundary. Backup may preserve encrypted/durable state but may
not turn it into an application-level access path.

## Implementation slices after decisions

### C0 — Contact and policy foundation

- Implement C13-1 owner-scoped continuity authorization and the attested C13-3 through C13-9
  recovery, revocation, lifetime, trustee-delivery, and atomicity policies
- Add verified beneficiary contact model and ceremony
- Add operator `brrr` onboarding and multi-channel Phase B reminder hardening; this slice may
  ship before recipient delivery because it strengthens the already-running check-in loop
- Add recipient-roster versioning plus safe active-holder removal/re-wrap ceremonies for the
  Letter and explicitly selected delivery documents
- Add operator readiness UI and backup coverage
- Lock delivery state machine and threat-model updates before serving documents

### C1 — Trustee verification window

- Add delivery run, trustee notification/action tokens, pause transition, owner recovery,
  durable outbox integration, and operations UI
- Assert trustee links expose no document metadata or key material

### C2 — Delivery manifests and grants

- Add explicit switch document scope per C13-4
- Build delivery-time preflight, grant/item snapshot, blocked-item policy, and idempotent
  recipient notification

### C3 — Scoped recipient doorway

- Add delivery-token exchange, short-lived scoped session, exact-item APIs, and local
  passphrase/WebAuthn unlock UI
- Preserve sealed envelope/projection state; authorization comes from the grant overlay

### C4 — Operations, backup, and hostile QA

- Retry/expiry/reissue controls, scheduler catch-up, audit timeline, backup/restore coverage,
  rate-limit and token-enumeration tests, real SMTP/browser/systemd operator acceptance

## Acceptance criteria

1. No trustee or recipient receives mail before the Phase C transition consumes a valid
   `delivery_pending` switch under lock.
2. A trustee pause token cannot list or fetch any document, key, holder, or envelope data.
3. Trustee pause is bounded and idempotent; repeated/concurrent use cannot extend the window
   beyond the attested policy.
4. When trustees exist, all are notified concurrently and have exactly 72 hours after the
   final required successful notification send to invoke the one shared pause. With no
   trustees, recipient delivery begins immediately after grace. A successful pause lasts
   exactly 30 days from the first valid action and cannot be stacked or extended.
5. If any designated trustee lacks a successful notification send, the run remains
   `trustee_notification_pending` or `trustee_notification_blocked`; no action-window deadline
   or beneficiary grant is created until bounded retry succeeds for every trustee.
6. Owner recovery requires same-request re-authentication and cannot falsely retract a grant
   already activated for a recipient.
7. Every recipient delivery address was verified and is snapshotted at grant issuance.
8. Every served item has a matching envelope-canonical holder identity, active key,
   fingerprint, sealed designation, encrypted file, and recipient-scoped grant.
9. Normal family-member and trustee-registration sessions cannot access delivered items.
10. Email, logs, audit, outbox, events, and backups contain no plaintext document content,
   private keys, DEKs, recovery words, or raw tokens.
11. Token expiry, replacement, cross-grant use, cross-recipient use, replay, and enumeration
   attempts fail uniformly without creating a normal app session.
12. Revoked, missing, inconsistent, or stranded items fail closed per C13-6 while healthy
    recipient/item outcomes follow the attested atomicity policy.
13. Recipient unlock occurs locally with existing passphrase/WebAuthn primitives; the server
    never claims to prove plaintext decryption.
14. Delivery does not mutate envelope holders or `document_designations.sealed` into ambient
    access authority.
15. Scheduler/outbox restarts, duplicate runs, and missed intervals do not duplicate grants,
    extend trustee windows, or send conflicting usable links.
16. Backup/restore preserves contacts, delivery runs, grants, manifests, tokens-as-hashes,
    events, outbox state, and encrypted artifacts from a consistent snapshot.
17. Phase D can later insert a quorum authorization result before grant activation without
    replacing Phase C contact, notification, manifest, or scoped-serving contracts.
18. Every logical owner reminder attempts email and enabled `brrr` independently with
    content-minimal payloads; no `brrr` secret or raw token appears in response bodies, logs,
    audits, events, or outbox rows.
19. A switch cannot arm from SMTP/provider test success alone. The authenticated owning parent
    must acknowledge a current, configuration-bound challenge through baseline email and every
    optional channel enabled for that switch; disabling an unverified optional channel is an
    explicit audited reduction in redundancy.
20. Recipient delivery links expire after seven days, scoped sessions after 60 minutes, and
    the underlying grant after one year. Self-service reissue sends only to the grant's
    snapshotted verified address, reveals no grant/address existence, replaces the prior link,
    and cannot extend the grant deadline.
21. Before local unlock, recipient APIs and UI identify every manifest item only as
    `Private document N`, including the Letter, and expose no server-side title, filename,
    type, description, tag, owner, or continuity-specific semantic metadata.

## Verification plan

### Unit/domain

- closed transition matrix, 72-hour trustee action deadline, no-trustee immediate release,
  30-day first-action pause cap, clock boundaries, and owner recovery cutoff
- contact normalization/verification/replacement
- delivery-token purpose, hash, expiry, replacement, replay, and session scope
- one-year hard grant deadline, seven-day replacement links, 60-minute sessions, uniform
  self-service reissue, immutable destination, and proof that retries cannot extend retention
- preflight classifications for active, revoked, missing, inconsistent, and stranded holders
- grant/item dedupe and partial/atomic policy
- per-trustee notification completion, permanent-failure blocking, retry recovery, and proof
  that the shared 72-hour deadline is based on the final required successful send
- per-channel reminder dedupe, retry, cooldown, target masking, and payload minimization
- separation of transport-test state from owner-reachability acknowledgement, including
  configuration-version invalidation and proof that acknowledgement cannot perform check-in

### Integration/API

- parent/kid/trustee/sessionless authorization matrix
- concurrent scheduler, pause, owner-recovery, and grant-activation races
- exact file/envelope/key serving constrained to recipient + grant + item
- recipient manifest responses expose deterministic generic ordinals but no server-side
  document semantics, including no special Letter label
- no generic document/search/share route leakage
- backup during concurrent delivery mutation
- arming rejects missing, expired, wrong-owner, wrong-switch, wrong-channel, replayed, and
  superseded-configuration reachability acknowledgements

### End-to-end

- verified beneficiary contact ceremony
- operator email/`brrr` transport tests, authenticated reachability ceremony, and dual-channel
  check-in reminders
- trustee mail, one bounded pause, expiry, and recipient release
- partial/permanent trustee notification failure blocks release until all designated trustees
  have a successful retry
- recipient mail, passphrase unlock, WebAuthn PRF unlock, expiry/reissue
- pre-unlock recipient UI/API shows only `Private document N`; decrypted artifact metadata is
  displayed only after successful local unlock
- expired-link self-service resend to the snapshotted address and terminal one-year expiry
- letter plus attested sealed-document scope
- revoked-key and missing-file blocked outcomes
- assert zero plaintext/token leakage across SMTP fixtures, logs, audits, and backup extraction

### Operational

- controlled rollout confirms zero Phase B switches in an armed-or-later active state before
  Phase C scheduler behavior is enabled; unarmed drafts may remain, and no legacy readiness
  state is inferred or backfilled
- persistent scheduler/outbox catch-up after downtime
- configuration-blocked and permanent/transient mail failure recovery
- Linux systemd timer verification and real SMTP delivery
- production-like backup/restore inspection before Phase C completion

## Risks

| Risk | Mitigation |
|---|---|
| False escalation releases sensitive ciphertext | Trustee window, owner recovery cutoff, explicit grant activation |
| Wrong email receives a link | Verified contact, immutable destination snapshot, identity-bound scoped session |
| Link bearer gets broader vault access | Grant-only session, no normal app session, exact-item APIs |
| Envelope/projection drift grants wrong holder | Envelope-canonical preflight and serve-time revalidation |
| Revocation is bypassed during emergency | Fail closed; no online revoked-key recovery in recommended policy |
| Operator expected documents are omitted or over-included | Explicit document-scope ceremony and immutable delivery manifest |
| Trustee authority becomes indefinite | One bounded pause, first valid use wins, no cancel authority |
| Provider success is mistaken for operator reachability | Separate transport and authenticated receipt signals; bind arming evidence to each selected channel configuration |
| Link loss strands a recipient after owner unavailability | One-year grant window with rate-limited self-service replacement to the immutable verified address |
| Delivery doorway leaks sensitive packet meaning | Generic deterministic item labels; no Letter distinction or server-side title/filename/type metadata before local unlock |
| Phase D forces a rewrite | Keep authorization gate separate from notification, manifest, and scoped serving |

## Stop condition

Phase C is complete only after the decision gates are attested, a `delivery_pending` switch
can safely traverse the trustee window and issue recipient-scoped grants, each recipient can
locally unlock only the explicitly authorized letter/documents, revocation and failure paths
fail closed, all durable state survives backup/restore and job restarts, the full regression
suite is green, and real SMTP/browser/systemd operator acceptance includes an authenticated
operator-reachability ceremony for every channel selected during arming.
