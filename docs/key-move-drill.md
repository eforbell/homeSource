# Drill: Home Source moved to a new address

Use this when Home Source starts answering at a new address and **Test Unlock** says the browser didn't get an
answer from a key, or the browser says the security key "is not registered with this website". For example, Home
Base's suite rollout moves Home Source to its own service hostname. The same steps cover a lost security key or
phone.

Run it as a drill once a year, with each person's real recovery words, so the words are known to work before
anyone depends on them.

## Why keys stop working

Every passkey and security key belongs to the website name it was registered on, its *RP ID*. Home Source uses
the hostname you opened it on (`WEBAUTHN_RP_ID` overrides it). A browser offers a key only on that name, so after
a move the key is fine but the browser won't use it at the new address. Every document it holds is still there,
encrypted to the same key; the app just can't open them.

**Re-register** fixes that without touching any document. The recovery words unlock the key in your browser, you
register a security key or passkey at the new address, and the same key is saved under it. The words are never
sent to Home Source, and they keep working afterwards.

## What each person needs

- [ ] Their Home Source sign-in at the **new** address.
- [ ] The 12 recovery words for each of their keys. A key without recovery words shows no **Re-register**
      button: it can only be used where it was registered (see [If a key has no recovery words](#if-a-key-has-no-recovery-words)).
- [ ] The security key, or the phone or computer for a passkey.

## 1. Take stock

- [ ] **Settings → Keys**: for each person, note their active keys, which show **Recovery set**, and the
      documents each protects (**View Protected Documents**).
- [ ] Take a backup (**Backup & Export → Create Backup**) before changing anything.

## 2. Re-register each key

Each person, signed in as themselves, for each of their keys:

- [ ] **Settings → Keys → Re-register** on the key.
- [ ] Type the 12 recovery words, in order. Choose **A security key** or **A passkey on this device**.
- [ ] **Re-register**, then touch the key (or confirm on the device) twice when the browser asks.
- [ ] **Test Unlock** on the key now passes.
- [ ] Open one of the documents it protects.

If the words are refused, the message says why: a misspelled word, words out of order, or words belonging to
another key. Nothing changes until the last step succeeds.

Each re-registration is recorded in the activity log (`key.reprotected`) and sends the same notice as a new key.

## 3. Trustees

Trustee keys were registered at the old address too, so a trustee would hit the same error at the new one.
Trustees have no Re-register yet, and a registered trustee can't be invited again. For each trustee:

- [ ] Note the documents and continuity grants they hold.
- [ ] **Revoke trustee**, then invite them again from the new address as a new trustee
      ([trustee-invitation-runbook.md](trustee-invitation-runbook.md)).
- [ ] Once they've registered, give them back the same documents and grants.

## 4. Write down what happened

- Date, how long it took, and anything that didn't match this drill.
- Which keys were re-registered, and on which security key or device.
- The next drill date.

## If a key has no recovery words

It can only be used at the address it was registered on. Either open Home Source at that address once more and
use the key there to add a holder to each document it protects (**Add Backup Key** on the document), or recover
the documents offline from a backup ([recovery-runbook.md](recovery-runbook.md)) and upload them again under a key
that has recovery words. Then generate recovery words for every key you keep: a key gets them when it's
registered.
