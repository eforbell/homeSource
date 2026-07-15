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
3. Confirm the trustee's email address and explain that they will either choose
   a separate continuity-key passphrase or use a compatible security key/device
   passkey. Home Source never receives a passphrase or a private key.

## Create an invitation

While signed in as a parent, open **Continuity → Trustees**, enter the name,
email, and optional relationship, then select **Send invitation**. The same
card shows invitation status, supports **Resend invitation** while the trustee
is still invited, and provides **Revoke trustee** when needed.

The server creates an `invited` trustee, generates a random 256-bit token,
stores only its SHA-256 hash, and emails the raw link. The API response never
contains the token. It reports whether the mail transport accepted delivery;
record and investigate a non-delivery immediately.

> **Delivery check:** a resend atomically replaces any unused link but still
> cannot prove remote mailbox delivery. Do not treat an unconfigured or failed
> mail transport as a successful handoff; resolve delivery before continuing.

## Trustee ceremony

1. The trustee opens the email link before its seven-day expiry.
2. They arrive at the sessionless `trustee-invite.html` page—there is no app
   navigation and no Home Source login.
3. They choose either a passphrase, a security key, or a device passkey; they
   may optionally label their key.
4. Their browser generates an X25519 keypair. A passphrase uses
   PBKDF2-SHA-256 (600,000 iterations) locally; a WebAuthn choice uses a
   registration plus PRF assertion locally. In both cases only the public key
   and wrapped private key are sent to Home Source.
5. The server atomically consumes the token, creates the trustee-owned key,
   and marks the trustee `registered`. The browser compares its locally derived
   fingerprint with the server result before showing success.

The link is single-use. Used, expired, and revoked links all return the same
unavailable result. It is normal for the link to remain in browser history or
proxy access logs, so treat it as a short-lived credential and avoid sharing it
outside the intended email channel.

## Verify and revoke

- A parent can open **Continuity** to see the trustee's `registered` status,
  active-key count, and designated-document count. The audit log records
  `trustee.invited`, `trustee.invitation_resent`, and `trustee.registered`.
- If the trustee should no longer participate, use **Revoke trustee** on that
  page (the underlying parent API is `DELETE /api/trustees/:trusteeId`).

Revocation blocks any unused invitation. It does not grant or revoke future
delivery authority; Phase C will define that authority explicitly.

## Known Phase A boundaries

- Security-key/passkey registration needs WebAuthn PRF support. The page gives
  a clear fallback to passphrase wrapping when an authenticator/browser does
  not expose it.
- A parent starts a trustee designation from an eligible **Seal** cell in the
  Continuity matrix or **Seal for Continuity** on an encrypted document. The
  document key is unwrapped and re-wrapped locally in the browser.
- A sealed designation is a product-route gate, not a new encryption primitive:
  a backup containing the envelope plus the recipient's private key can decrypt
  the pre-wrapped document outside Home Source. This is documented in the
  Phase A plan and is why delivery authority remains deferred to Phase C.
