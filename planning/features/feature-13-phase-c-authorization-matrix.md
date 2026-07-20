# Feature #13 Phase C — Continuity Authorization Matrix

Date: 2026-07-19
Status: C0.4 implemented and automated
Shared resolver: `lib/continuity-authorization.js`

## Principal and artifact rules

- A staged Letter is never exposed through generic document routes, including to its owner.
- An active or archived Letter is visible only to the owning switch operator. Generic document
  mutation remains disabled; replacement and activation stay inside the continuity workflow.
- Packet-bound ordinary documents retain ordinary read/download access, but packet
  administration and continuity-holder mutation require the packet owner.
- A sealed `deadman_trigger` holder is removed from generic document and key-info responses
  unless the actor owns the document and is authorized for its packet policy.
- An unknown authorization mode fails closed. C3 exact-item grants must extend this resolver
  with durable active-grant evidence rather than add a parallel access path.

## Route matrix

| Surface | Routes / modules | C0.4 enforcement |
| --- | --- | --- |
| List and search | `GET /api/documents`, `GET /api/search` | Hide another operator's Letter; redact sealed holders from otherwise visible ordinary rows. |
| Detail and local-unlock bootstrap | `GET /api/documents/:id`, `GET /api/documents/:id/key-info`, MagicIndex status | Resolve the actor once; deny hidden Letters and remove sealed wraps, holder identities, and sealed key records when full-envelope access is absent. |
| Encrypted files | `GET /api/documents/:id/files/:fileId/download` | Owner-only for Letters; normal access remains for ordinary packet documents. |
| Document mutation | update, encrypt, archive/delete, files, owners, tags | Generic Letter mutation is denied. Packet-bound ordinary mutation requires a packet owner. Reserved continuity metadata cannot be written through generic update. |
| Holder and seal mutation | seal/unseal and PKI add/replace/remove routes | Require document ownership plus packet-owner authority; Letter envelopes are changed only by the continuity workflow. |
| Share paths | create/list and public share/file routes | Resolver gates authenticated share administration; encrypted documents remain ineligible for public sharing, so Letters and encrypted packet documents cannot become public links. |
| Links and insights | document/global Magic Links, insight list/detail/update/delete/summary, scanners | Hidden Letter references are filtered; mutations require authorization for every referenced document; deterministic scanners exclude Letter artifacts. |
| Aggregate posture | dashboard stats, PKI posture, key dependencies, continuity directory | Hide Letter titles/counts from other parents, redact hidden dependency identity without weakening internal key-revocation safeguards, and scope designation/contact inventory to the operator. |
| Trustee administration | trustee list, keys, resend, replacement, revoke, continuity key options | Scope reusable trustees and trustee keys to `created_by` owner. |
| Packet policy | continuity packet GET/stage and Letter commit | Existing owner/switch checks remain authoritative; no packet row grants generic document access. |
| Import/export | upload, scan, URL and batch import; app backup export/download | Imports create new actor-owned documents and cannot target a Letter. Backup preserves encrypted durable state but creates no app session, grant, unseal, or restore-time authority. |
| Restore | no application restore endpoint exists | Any future restore must preserve hashes/ciphertext and re-enter this resolver; database presence alone is not authorization. |

## Regression evidence

`test/continuity-authorization.test.js` exercises hostile second-parent access across list,
search, detail, key-info, file, mutation, share, link, packet, directory, stats, PKI posture,
key-dependency, and insight surfaces while proving ordinary ciphertext access remains intact and
sealed wraps do not leak.
