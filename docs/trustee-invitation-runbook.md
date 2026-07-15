# Trustee Invitation Runbook

This runbook covers the Phase A trustee ceremony that exists today. It creates
a trustee-owned X25519 keypair for future continuity designations. It does
**not** give the trustee an app session, document access, or delivery authority.
Those are later Phase C concerns.

## Before inviting

1. Set a canonical, browser-reachable `APP_URL` using HTTPS (or `localhost`
   only for local development). The one-time link is built from this value.
2. Configure and test SMTP (`SMTP_HOST` and `SMTP_FROM` at minimum; configure
   `SMTP_USER` and `SMTP_PASS` together when the relay requires authentication).
   The invite is best-effort, so do not create a real invitation while mail is
   disabled or unverified.
3. Confirm the trustee's email address and explain that they will choose a
   separate continuity-key passphrase. Home Source never receives that
   passphrase.

## Create an invitation

The current Phase A UI lists trustee status on **Continuity**, but trustee
creation is presently API-only. While signed in as a parent, submit:

```http
POST /api/trustees
Content-Type: application/json

{
  "name": "Morgan Trustee",
  "relationship": "Attorney",
  "email": "morgan@example.com"
}
```

The server creates an `invited` trustee, generates a random 256-bit token,
stores only its SHA-256 hash, and emails the raw link. The API response never
contains the token. It reports whether the mail transport accepted delivery;
record and investigate a non-delivery immediately.

> **Current limitation:** there is not yet a resend-invitation endpoint. Do
> not treat an unconfigured or failed mail transport as a successful handoff.
> Resolve the delivery configuration before beginning the ceremony.

## Trustee ceremony

1. The trustee opens the email link before its seven-day expiry.
2. They arrive at the sessionless `trustee-invite.html` page—there is no app
   navigation and no Home Source login.
3. They choose a passphrase, confirm it, optionally label their key, and submit.
4. Their browser generates an X25519 keypair and uses PBKDF2-SHA-256 (600,000
   iterations) to wrap the private key locally. Only the public key and wrapped
   private key are sent to Home Source.
5. The server atomically consumes the token, creates the trustee-owned key,
   and marks the trustee `registered`. The browser compares its locally derived
   fingerprint with the server result before showing success.

The link is single-use. Used, expired, and revoked links all return the same
unavailable result. It is normal for the link to remain in browser history or
proxy access logs, so treat it as a short-lived credential and avoid sharing it
outside the intended email channel.

## Verify and revoke

- A parent can open **Continuity** to see the trustee's `registered` status and
  designated-document count. The audit log records `trustee.invited` and
  `trustee.registered`.
- If the trustee should no longer participate, revoke the trustee through the
  parent API:

```http
DELETE /api/trustees/:trusteeId
```

Revocation blocks any unused invitation. It does not grant or revoke future
delivery authority; Phase C will define that authority explicitly.

## Known Phase A boundaries

- Trustee registration currently uses a passphrase-protected key. Trustee
  WebAuthn/passkey registration is not implemented yet.
- A registered trustee key can be selected by the sealed-designation API, but
  the parent-facing trustee-wrapping UI is still follow-up work.
- A sealed designation is a product-route gate, not a new encryption primitive:
  a backup containing the envelope plus the recipient's private key can decrypt
  the pre-wrapped document outside Home Source. This is documented in the
  Phase A plan and is why delivery authority remains deferred to Phase C.
