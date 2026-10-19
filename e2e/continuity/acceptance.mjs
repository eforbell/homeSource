#!/usr/bin/env node
// Feature 13 continuity acceptance drill, automated against the disposable Homebase test host
// built by harness.sh. Follows docs/continuity-phase-c-acceptance-runbook.md §5-§14 except the
// tailnet publishing checks.
//
// People act in separate browser profiles (Playwright/Chromium) on the sessionless pages they
// receive by email, including a PRF security key for the trustee-recipient. The operator drives
// the Continuity page in the browser; key setup, uploads, and seal ceremonies use the shipped
// browser crypto against the same APIs those pages call. Time-based milestones use the runbook's
// accelerated simulation driver.
//
// Usage: node e2e/continuity/acceptance.mjs [--until <phase>] [--skip <phase,...>]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  CONFIG, REPO, AppSession, request, sql, sqlOne, simulateAt, systemctl, startUnitAndJournal, hostSh,
  setRelayReachable, clearMailboxes, mailTo, waitForMail, linkFrom, launchBrowser, newProfile,
  attachSecurityKey, download, rememberSecret, knownSecrets, redact, run
} from './lib/env.mjs';
import {
  PKICrypto, registerPassphraseKey, testKeyUnlock, enableRecoveryWords, uploadPlain, uploadPki,
  sealDesignation, decryptAsMember
} from './lib/ceremonies.mjs';

const args = process.argv.slice(2);
const until = args.includes('--until') ? args[args.indexOf('--until') + 1] : null;
const skip = new Set(args.includes('--skip') ? args[args.indexOf('--skip') + 1].split(',') : []);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const EVIDENCE = path.join(REPO, 'e2e', 'continuity', 'evidence', stamp);
fs.mkdirSync(EVIDENCE, { recursive: true });

// ── Recording ────────────────────────────────────────────────────────────────

const results = [];
const deviations = [];
let currentPhase = 'setup';
function log(message) { console.log(`  ${redact(message)}`); }
function evidence(name, content) {
  const target = path.join(EVIDENCE, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof content === 'string' ? redact(content) : redact(JSON.stringify(content, null, 2)));
}
class DrillFailure extends Error {}
function check(condition, label, detail) {
  results.push({ phase: currentPhase, label, ok: !!condition, detail: detail === undefined ? undefined : redact(JSON.stringify(detail)) });
  console.log(`  ${condition ? 'PASS' : 'FAIL'} ${label}${!condition && detail !== undefined ? ` — ${redact(JSON.stringify(detail)).slice(0, 400)}` : ''}`);
  if (!condition) throw new DrillFailure(label);
}
// A failed acceptance criterion that does not block the rest of the drill.
function finding(label, detail) {
  results.push({ phase: currentPhase, label, ok: false, finding: true, detail: detail === undefined ? undefined : redact(JSON.stringify(detail)) });
  console.log(`  FINDING ${label}${detail !== undefined ? ` — ${redact(JSON.stringify(detail)).slice(0, 400)}` : ''}`);
}
function deviate(text) { deviations.push({ phase: currentPhase, text }); console.log(`  NOTE ${text}`); }
async function shot(page, name) {
  await page.screenshot({ path: path.join(EVIDENCE, 'screenshots', `${name}.png`), fullPage: true });
}
// A control the page marks `hidden` must not be shown; a visible one is a non-blocking finding.
async function expectHidden(page, selector, label) {
  const visible = await page.isVisible(selector);
  if (visible) {
    await shot(page, `finding-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`);
    finding(label, { selector, hidden_attribute: await page.$eval(selector, (el) => el.hidden), display: await page.$eval(selector, (el) => getComputedStyle(el).display) });
  } else check(true, label);
}
async function expectFailure(label, fn, matcher) {
  let error = null;
  try { await fn(); } catch (err) { error = err; }
  check(error && (!matcher || matcher.test(error.message)), label, error ? error.message : 'no error');
}

// ── Test household, documents, and mailboxes ────────────────────────────────

const MAIL = {
  owner: 'hs-owner-test@hs.test', kid: 'hs-kid-test@hs.test', trustee: 'hs-trustee-recipient@hs.test',
  witness: 'hs-witness-test@hs.test', witness2: 'hs-witness2-test@hs.test',
  spouse: 'hs-spouse-test@hs.test', witness3: 'hs-witness3-test@hs.test', revoked: 'hs-revoked-test@hs.test'
};
const PEOPLE = {
  owner: { name: 'Pat', role: 'parent', login: rememberSecret('test-login-pat-7731'), keyPass: rememberSecret('test-key-pat-5520') },
  kid: { name: 'Kit', role: 'kid', login: rememberSecret('test-login-kit-1188'), keyPass: rememberSecret('test-key-kit-9043') },
  spouse: { name: 'Sam', role: 'parent', login: rememberSecret('test-login-sam-4410'), keyPass: rememberSecret('test-key-sam-2276') }
};
const TRUSTEES = {
  recipient: { name: 'Robin Trustee', email: MAIL.trustee, relationship: 'Family friend' },
  witness: { name: 'Wren Witness', email: MAIL.witness, relationship: 'Neighbor', pass: rememberSecret('test-witness-wren-3301') },
  witness2: { name: 'Wade Witness', email: MAIL.witness2, relationship: 'Attorney', pass: rememberSecret('test-witness-wade-6650') },
  witness3: { name: 'Willa Witness', email: MAIL.witness3, relationship: 'Sister', pass: rememberSecret('test-witness-willa-8842') }
};
const MARKERS = {
  letter: 'E2E-MARKER-LETTER-7f3a', will: 'E2E-MARKER-WILL-91c2', accounts: 'E2E-MARKER-ACCOUNTS-44d8',
  medical: 'E2E-MARKER-MEDICAL-0b6e', spouseLetter: 'E2E-MARKER-SPOUSE-LETTER-5e19'
};
const TITLES = { will: 'TEST — Will', accounts: 'TEST — Account instructions', medical: 'TEST — Medical directive (owner only)' };
const LETTER = `TEST LETTER — invented content for the continuity acceptance drill.\n${MARKERS.letter}\nKit and Robin: this is not a real letter.`;
const SPOUSE_LETTER = `TEST LETTER from Sam — invented.\n${MARKERS.spouseLetter}`;

const state = { trustees: {}, docs: {}, keys: {}, links: {} };
const sessions = {};
let browser;
const profiles = {};

// Plaintext "assortment" documents: tiny invented PDFs and a PNG "scan".
async function fakePdf(title, lines) {
  const { PDFDocument, StandardFonts } = createRequire(path.join(REPO, 'package.json'))('pdf-lib');
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  [title, 'INVENTED TEST DOCUMENT — NOT A REAL RECORD', ...lines].forEach((line, i) =>
    page.drawText(line, { x: 56, y: 720 - i * 22, size: i === 0 ? 18 : 11, font }));
  return Buffer.from(await pdf.save());
}
async function fakeScanPng(label) {
  const sharp = createRequire(path.join(REPO, 'package.json'))('sharp');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect width="100%" height="100%" fill="#f3efe6"/><text x="40" y="80" font-size="40" font-family="sans-serif">${label}</text><text x="40" y="140" font-size="24" font-family="sans-serif">INVENTED TEST SCAN</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// ── Shared steps ─────────────────────────────────────────────────────────────

async function openSessionless(page, url) {
  const target = new URL(url);
  await page.goto(target.pathname.replace(/^\/source\//, '') + target.search);
}

async function switchFor(session) {
  return (await session.get('api/continuity/switch')).switch;
}

function runFor(switchId) {
  return sqlOne(`SELECT * FROM continuity_delivery_runs WHERE switch_id = $1 ORDER BY id DESC LIMIT 1`, [switchId]);
}

function minutesAfter(value, minutes) { return new Date(new Date(value).getTime() + minutes * 60_000); }
const DAY = 24 * 60 * 60_000;

async function inviteTrustee(session, trustee) {
  const created = await session.post('api/trustees', { name: trustee.name, email: trustee.email, relationship: trustee.relationship });
  check(created.invitation.delivered === true, `${trustee.name}: invitation accepted by the SMTP relay`, created.invitation);
  const mail = await waitForMail({ to: trustee.email, subject: /continuity invitation/ });
  check(mail.to.length === 1 && mail.to[0] === trustee.email, `${trustee.name}: invitation addressed only to their mailbox`, mail.to);
  const link = linkFrom(mail, 'trustee-invite.html');
  check(link.origin + link.pathname === `${CONFIG.appUrl}trustee-invite.html`, `${trustee.name}: invitation link uses APP_URL /source/`, link.origin + link.pathname);
  return { id: created.trustee.id, link };
}

async function registerTrusteeWithPassphrase(profile, link, label, passphrase) {
  const { page } = profile;
  await openSessionless(page, link.url);
  await page.locator('#registration-form').waitFor({ state: 'visible' });
  await page.fill('#key-label', label);
  await page.fill('#passphrase', passphrase);
  await page.fill('#passphrase-confirm', passphrase);
  await page.click('#register-button');
  await page.waitForFunction(() => document.getElementById('invitation-summary').textContent.includes('registered'), null, { timeout: 60_000 });
}

// The Continuity page's stage → contact → readiness → arm sequence, as the operator clicks it.
async function armViaContinuityPage({ who, session, page, reminderEmail, recipients, packetDocs, witnesses, letter, kidEmail, prefix }) {
  await page.goto('continuity.html');
  await page.waitForFunction(() => document.getElementById('switch-badge').textContent !== 'Loading');
  await page.fill('#reminder-email', reminderEmail);
  await page.selectOption('#interval-days', '30');
  await page.fill('#grace-days', '7');
  for (const name of recipients) await page.locator('#switch-recipients label', { hasText: name }).locator('input').check();
  for (const title of packetDocs) await page.locator('#packet-documents label', { hasText: title }).locator('input').check();
  for (const name of witnesses) await page.locator('#packet-witnesses label', { hasText: name }).locator('input').check();
  await page.fill('#letter-body', letter);
  await page.click('#stage-letter');
  await page.waitForFunction(() => /staged|Error|error|must|required/i.test(document.getElementById('switch-message').textContent), null, { timeout: 60_000 });
  const stageMessage = await page.textContent('#switch-message');
  check(/Encrypted packet staged/.test(stageMessage), `${who}: letter encrypted in the browser and packet staged`, stageMessage);
  await shot(page, `${prefix}-01-staged`);

  const draft = await switchFor(session);
  check(draft.status === 'draft' && draft.interval_days === 30 && draft.grace_period_days === 7, `${who}: draft switch has 30-day cadence and 7-day grace`, draft);

  // Phase C reachability preparation (runbook §7.5).
  await page.reload();
  await page.locator('[data-reachability-challenge="email"]').waitFor();
  await page.click('[data-reachability-challenge="email"]');
  await page.waitForFunction(() => /challenge/.test(document.getElementById('switch-message').textContent));
  check(/email challenge sent/.test(await page.textContent('#switch-message')), `${who}: reachability challenge accepted by transport`);
  const codeMail = await waitForMail({ to: reminderEmail, subject: /reachability confirmation/ });
  const code = codeMail.text.match(/reachability code: (\S+)/)?.[1];
  rememberSecret(code);
  check(!!code, `${who}: reachability code received at ${reminderEmail}`);
  await page.fill('[data-reachability-code="email"]', code);
  await page.click('[data-reachability-ack="email"]');
  await page.waitForFunction(() => document.getElementById('reachability-badge').textContent === 'Reachable', null, { timeout: 30_000 });
  const readiness = await session.get(`api/continuity/switch/${draft.id}/readiness`);
  check(readiness.ready_to_arm && readiness.channels.email.transport_tested && readiness.channels.email.reachability_acknowledged,
    `${who}: email channel transport-accepted and receipt-acknowledged`, readiness.channels.email);

  // Negative: wrong passphrase, then an unverified beneficiary contact, must not arm.
  await page.fill('#commit-passphrase', 'definitely-wrong-passphrase');
  await page.click('#commit-form button');
  await page.waitForFunction(() => /incorrect/i.test(document.getElementById('switch-message').textContent));
  check(true, `${who}: arming refused with a wrong login passphrase`);
  if (kidEmail) {
    const login = PEOPLE[who === 'operator' ? 'owner' : 'spouse'].login;
    await expectFailure(`${who}: arming refused while the beneficiary contact is unverified`,
      () => session.post(`api/continuity/switch/${draft.id}/letter/commit`, { current_passphrase: login, operation_key: `neg-${Date.now()}` }),
      /verified contact/i);

    // Beneficiary contact verification (runbook §6.6), started from the People card.
    const kidCard = page.locator('[data-member-contact-form]').first();
    await kidCard.locator('input[name="email"]').fill(kidEmail);
    await kidCard.locator('button[type="submit"]').click();
    await page.waitForFunction(() => /Verification email sent|could not be confirmed/.test(document.getElementById('switch-message').textContent));
    check(/Verification email sent/.test(await page.textContent('#switch-message')), `${who}: beneficiary verification sent`);
    const verifyMail = await waitForMail({ to: kidEmail, subject: /Confirm a private Home Source contact address/ });
    check(verifyMail.to.length === 1, `${who}: verification mail addressed only to the beneficiary`, verifyMail.to);
    const verifyLink = linkFrom(verifyMail, 'continuity-contact.html');
    const kidBrowser = await newProfile(browser);
    await openSessionless(kidBrowser.page, verifyLink.url);
    await kidBrowser.page.locator('#confirm-button').waitFor({ state: 'visible' });
    await kidBrowser.page.click('#confirm-button');
    await kidBrowser.page.waitForFunction(() => document.getElementById('summary').textContent.includes('confirmed'));
    check((await kidBrowser.context.cookies()).every((c) => c.name !== 'hs_session'), `${who}: contact confirmation created no app session`);
    await kidBrowser.context.close();
    const directory = await session.get('api/continuity/directory');
    const kidRow = directory.members.filter((m) => m.name === PEOPLE.kid.name);
    check(kidRow.length === 1 && kidRow[0].contact_status === 'verified' && kidRow[0].contact_address === kidEmail,
      `${who}: beneficiary has exactly one verified contact`, kidRow);
  }

  await page.reload();
  await page.locator('#commit-form').waitFor({ state: 'visible' });
  await page.fill('#commit-passphrase', PEOPLE[who === 'operator' ? 'owner' : 'spouse'].login);
  await page.click('#commit-form button');
  await page.waitForFunction(() => /armed|Error|must|required/i.test(document.getElementById('switch-message').textContent), null, { timeout: 30_000 });
  check(/The letter is armed/.test(await page.textContent('#switch-message')), `${who}: switch armed from the Continuity page`, await page.textContent('#switch-message'));
  await shot(page, `${prefix}-02-armed`);
  return switchFor(session);
}

// Recipient doorway: exchange the link in this profile, return the private item buttons.
async function openDelivery(page, url) {
  await openSessionless(page, url);
  await page.waitForFunction(() => !document.getElementById('items').hidden || /unavailable|expired/.test(document.getElementById('summary').textContent), null, { timeout: 30_000 });
  return page.$$eval('#items button', (buttons) => buttons.map((b) => b.textContent));
}

async function unlockAll(page, { passphrase, passkey }) {
  const labels = await page.$$eval('#items button', (buttons) => buttons.map((b) => b.textContent));
  const files = [];
  for (const label of labels) {
    await page.locator('#items button', { hasText: new RegExp(`^${label}$`) }).click();
    await page.locator('#unlock').waitFor({ state: 'visible' });
    await page.waitForFunction((l) => document.getElementById('status').textContent.includes(`${l.split(' ').pop()} selected`), label);
    if (passkey) {
      await page.locator('#passkey-button').waitFor({ state: 'visible' });
      await page.click('#passkey-button');
    } else {
      await page.fill('#passphrase', passphrase);
      await page.click('#unlock-button');
    }
    await page.waitForFunction(() => /Unlocked locally|Unable|unavailable|did not/.test(document.getElementById('status').textContent), null, { timeout: 90_000 });
    const status = await page.textContent('#status');
    if (!/Unlocked locally/.test(status)) return { files, error: status, label };
    const file = await download(page, () => page.click('#result a'));
    files.push({ label, name: file.name, text: file.bytes.toString('utf8') });
  }
  return { files };
}

async function sessionStorageBearer(page) {
  const bearer = await page.evaluate(() => sessionStorage.getItem('homesource-recipient-delivery-bearer'));
  return rememberSecret(bearer);
}

// ── Phases ───────────────────────────────────────────────────────────────────

const phases = [];
function phase(id, title, fn) { phases.push({ id, title, fn }); }

phase('preflight', '§4.5/§5 Homebase install, health, services, timers', async () => {
  const health = await request('GET', 'api/health');
  const ready = await request('GET', 'api/ready');
  const bootstrap = await request('GET', 'api/bootstrap');
  check(health.status === 200 && health.json().status === 'ok', 'gateway /source/api/health ok', health.json());
  check(ready.status === 200 && ready.json().checks?.db === 'ok', 'gateway /source/api/ready ok', ready.json());
  check(bootstrap.json()?.bootstrap?.needs_household === true, '/api/bootstrap reports a household is needed', bootstrap.json());
  const commit = hostSh(`git -C ${CONFIG.appDir} log -1 --format='%H %s'`).stdout.trim();
  const expected = process.env.HS_E2E_EXPECT_COMMIT || run('git', ['-C', REPO, 'rev-parse', 'main']).stdout.trim();
  check(commit.startsWith(expected), `Homebase installed the expected commit (${process.env.HS_E2E_EXPECT_COMMIT ? 'HS_E2E_EXPECT_COMMIT' : 'local main'})`, { installed: commit, expected });
  state.installedCommit = commit;
  const units = hostSh(`systemctl cat home-source.service home-source-continuity-check.service home-source-continuity-outbox.service home-source-continuity-check.timer home-source-continuity-outbox.timer`).stdout;
  evidence('systemd/units.txt', units);
  check(/ExecStart=\/usr\/bin\/node bin\/deadman-check\.js --once/.test(units), 'check service runs node bin/deadman-check.js --once');
  check(/ExecStart=\/usr\/bin\/node bin\/continuity-outbox\.js --once/.test(units), 'outbox service runs node bin/continuity-outbox.js --once');
  check((units.match(/WorkingDirectory=\/opt\/sovereign-home\/apps\/homeSource/g) || []).length === 3, 'app and both workers share the Homebase-managed checkout');
  const timers = hostSh(`systemctl is-enabled home-source-continuity-check.timer home-source-continuity-outbox.timer; systemctl is-active home-source-continuity-check.timer home-source-continuity-outbox.timer; systemctl list-timers 'home-source-continuity-*' --no-pager`).stdout;
  evidence('systemd/timers.txt', timers);
  check((timers.match(/^enabled$/gm) || []).length === 2 && (timers.match(/^active$/gm) || []).length === 2, 'both continuity timers enabled and waiting', timers);
  evidence('systemd/status.txt', systemctl('status', 'home-source', 'home-source-continuity-check.timer', 'home-source-continuity-outbox.timer', '--no-pager').stdout);
  for (const unit of ['home-source-continuity-check.service', 'home-source-continuity-outbox.service']) {
    const smoke = startUnitAndJournal(unit);
    evidence(`systemd/smoke-${unit}.log`, smoke.journal);
    check(smoke.exit === 0 && /"ok":true/.test(smoke.journal), `no-work smoke run of ${unit} succeeded`, smoke.journal.slice(-600));
  }
  await clearMailboxes();
});

phase('onboard', '§6.1-6.3 household, login passphrases, member PKI keys', async () => {
  const { page, context } = await newProfile(browser);
  await page.goto('setup');
  await page.click('#add-member-btn');
  await page.click('#add-member-btn');
  const rows = page.locator('.member-row');
  for (const [i, person] of [PEOPLE.owner, PEOPLE.kid, PEOPLE.spouse].entries()) {
    await rows.nth(i).locator('.member-name').fill(person.name);
    await rows.nth(i).locator('.member-role').selectOption(person.role);
    await rows.nth(i).locator('.member-pass').fill(person.login);
  }
  await page.click('#setup-btn');
  await page.waitForURL((url) => !url.pathname.endsWith('/setup'), { timeout: 30_000 });
  await context.close();
  const bootstrap = (await request('GET', 'api/bootstrap')).json();
  check(bootstrap.bootstrap.ready === true && bootstrap.counts.family_members === 3, 'household created from /source/setup', bootstrap);
  check((await request('GET', 'api/ready')).status === 200, '/api/ready remains successful after onboarding');

  for (const role of ['owner', 'kid', 'spouse']) {
    const person = PEOPLE[role];
    sessions[role] = await new AppSession(person.name).login(person.name, person.login);
    const registered = await registerPassphraseKey(sessions[role], person.keyPass, `${person.name} test key`);
    check(registered.key.key_fingerprint === registered.localFingerprint, `${person.name}: server fingerprint matches the locally generated key`);
    state.keys[role] = { ...registered.key, privateKey: registered.privateKey, pkcs8: registered.privateKeyPkcs8 };
    check(await testKeyUnlock(sessions[role], registered.key.id, person.keyPass), `${person.name}: local unlock of the wrapped private key works`);
  }
  state.mnemonic = await enableRecoveryWords(sessions.owner, state.keys.owner.id, state.keys.owner.privateKey);
  const keys = await sessions.owner.get(`api/members/${sessions.owner.member.id}/keys`);
  check(keys.length === 1 && keys[0].recovery_enabled === true, 'Pat: recovery words enabled for the owner key', keys);
  await expectFailure('kid login cannot open parent-only continuity APIs', () => sessions.kid.get('api/continuity/switch'), /403|401/);
});

phase('documents', 'assortment of invented documents (plaintext and PKI-encrypted)', async () => {
  const plain = [
    { title: 'Dishwasher warranty', documentType: 'warranty', filename: 'dishwasher-warranty.pdf', bytes: await fakePdf('Dishwasher warranty', ['Model DW-0000', 'Coverage: 2 years parts and labor']), mime: 'application/pdf', expiry: '2028-03-01' },
    { title: 'Homeowners insurance declarations', documentType: 'insurance', filename: 'home-insurance.pdf', bytes: await fakePdf('Homeowners insurance declarations', ['Policy TEST-000-111', 'Dwelling coverage: $0 (invented)']), mime: 'application/pdf', expiry: '2027-06-30' },
    { title: 'Furnace manual', documentType: 'manual', filename: 'furnace-manual.pdf', bytes: await fakePdf('Furnace manual', ['Filter: 16x25x1', 'Service every autumn']), mime: 'application/pdf' },
    { title: 'Passport scan (TEST)', documentType: 'identification', filename: 'passport-scan.png', bytes: await fakeScanPng('PASSPORT — TEST ONLY'), mime: 'image/png', expiry: '2031-01-15' },
    { title: 'Birth certificate (TEST)', documentType: 'certificate', filename: 'birth-certificate.pdf', bytes: await fakePdf('Certificate of Birth', ['Name: Kit Tester (invented)', 'Registry: none']), mime: 'application/pdf' }
  ];
  for (const doc of plain) {
    const created = await uploadPlain(sessions.owner, doc);
    state.docs[doc.title] = created;
  }
  const encrypted = [
    ['will', 'legal', TITLES.will, 'will.txt', `INVENTED WILL FOR TESTING.\n${MARKERS.will}\n`],
    ['accounts', 'other', TITLES.accounts, 'account-instructions.txt', `INVENTED ACCOUNT INSTRUCTIONS.\n${MARKERS.accounts}\n`],
    ['medical', 'medical', TITLES.medical, 'medical-directive.txt', `INVENTED MEDICAL DIRECTIVE — owner only.\n${MARKERS.medical}\n`]
  ];
  for (const [key, documentType, title, filename, text] of encrypted) {
    const { doc, dekB64 } = await uploadPki(sessions.owner, state.keys.owner, PEOPLE.owner.keyPass,
      { title, documentType, filename, mime: 'text/plain', bytes: Buffer.from(text) });
    state.docs[key] = { ...doc, dekB64, filename, text };
    const plaintext = Buffer.from(await decryptAsMember(sessions.owner, doc.id, state.keys.owner, PEOPLE.owner.keyPass)).toString('utf8');
    check(plaintext === text, `${title}: owner decrypts the uploaded ciphertext locally`);
  }
  const listed = await sessions.owner.get('api/documents?limit=100');
  const count = Array.isArray(listed) ? listed.length : (listed.documents || listed.items || []).length;
  check(count >= 8, 'eight invented documents are in the vault', { count });
  const kidList = await sessions.kid.get('api/documents?limit=100');
  const kidTitles = JSON.stringify(kidList);
  check(!kidTitles.includes(TITLES.will) && !kidTitles.includes(TITLES.accounts), 'kid cannot list the parent-owned encrypted documents');
});

phase('trustees', '§6.4-6.5 trustee invitations and key ceremonies (passphrase and PRF security key)', async () => {
  for (const role of ['witness', 'witness2', 'recipient']) {
    state.trustees[role] = await inviteTrustee(sessions.owner, TRUSTEES[role]);
  }
  for (const role of ['witness', 'witness2']) {
    profiles[role] = await newProfile(browser);
    await registerTrusteeWithPassphrase(profiles[role], state.trustees[role].link, `${TRUSTEES[role].name} key`, TRUSTEES[role].pass);
    check(true, `${TRUSTEES[role].name}: registered with a passphrase-wrapped key`);
  }
  // The trustee-recipient's tab carries a CTAP2 security key with PRF: it is their device.
  profiles.recipient = await newProfile(browser);
  profiles.recipient.key = await attachSecurityKey(profiles.recipient.page);
  const robin = profiles.recipient.page;
  await openSessionless(robin, state.trustees.recipient.link.url);
  await robin.locator('#registration-form').waitFor({ state: 'visible' });
  await robin.fill('#key-label', 'Robin security key');
  await robin.click('#security-key-button');
  await robin.waitForFunction(() => document.getElementById('invitation-summary').textContent.includes('registered')
    || (document.getElementById('status').style.color && document.getElementById('status').textContent), null, { timeout: 60_000 });
  const robinStatus = await robin.textContent('#status');
  if ((await robin.textContent('#invitation-summary')).includes('registered')) {
    state.robinUnlock = 'passkey';
    check(/authenticator/.test(robinStatus), 'Robin: registered through WebAuthn with a PRF-wrapped key', robinStatus);
    check((await profiles.recipient.key.credentials()).length === 1, 'Robin: exactly one credential on the security key');
  } else {
    await shot(robin, 'trustee-recipient-security-key-failed');
    const node = hostSh('node -v').stdout.trim();
    finding('Robin: security-key (WebAuthn PRF) registration works on the Homebase host', { page: robinStatus, host_node: node });
    deviate(`Security-key registration failed on the Homebase runtime (${node}); per runbook §2 the trustee-recipient falls back to the passphrase path so the rest of the drill can run.`);
    state.robinUnlock = 'passphrase';
    TRUSTEES.recipient.pass = rememberSecret('test-trustee-robin-7720');
    await robin.fill('#passphrase', TRUSTEES.recipient.pass);
    await robin.fill('#passphrase-confirm', TRUSTEES.recipient.pass);
    await robin.click('#register-button');
    await robin.waitForFunction(() => document.getElementById('invitation-summary').textContent.includes('registered'), null, { timeout: 60_000 });
    check(true, 'Robin: registered with the passphrase fallback using the same invitation');
  }
  await shot(robin, 'trustee-recipient-registered');

  // Negative: used and revoked invitations are unavailable.
  const replay = await newProfile(browser);
  await openSessionless(replay.page, state.trustees.witness.link.url);
  await replay.page.waitForFunction(() => document.getElementById('invitation-summary').textContent !== 'Checking your invitation…');
  check((await replay.page.textContent('#invitation-summary')).includes('no longer available'), 'a used invitation link is unavailable');
  const revoked = await inviteTrustee(sessions.owner, { name: 'Rex Revoked', email: MAIL.revoked, relationship: 'Test' });
  await sessions.owner.del(`api/trustees/${revoked.id}`);
  await openSessionless(replay.page, revoked.link.url);
  await replay.page.waitForFunction(() => document.getElementById('invitation-summary').textContent !== 'Checking your invitation…');
  check((await replay.page.textContent('#invitation-summary')).includes('no longer available'), 'a revoked trustee invitation is unavailable');
  await replay.context.close();

  const directory = await sessions.owner.get('api/continuity/directory');
  for (const role of ['witness', 'witness2', 'recipient']) {
    const row = directory.trustees.find((t) => t.name === TRUSTEES[role].name);
    check(row?.status === 'registered' && Number(row.active_key_count) === 1, `${TRUSTEES[role].name}: registered with one active key`, row);
    check(row.verified_contact_address === TRUSTEES[role].email, `${TRUSTEES[role].name}: trustee address shown as verified`, row.verified_contact_address);
  }
  const rex = directory.trustees.find((t) => t.name === 'Rex Revoked');
  check(!rex || rex.status === 'revoked', 'revoked trustee is not registered', rex);
});

phase('seal', '§7.1-7.2 seal designations for the beneficiary and trustee-recipient', async () => {
  const options = await sessions.owner.get('api/continuity/key-options');
  const kidKey = options.find((k) => k.member_name === PEOPLE.kid.name);
  const robinKey = options.find((k) => k.trustee_name === TRUSTEES.recipient.name);
  check(kidKey && robinKey, 'key options offer the beneficiary and trustee-recipient keys', options.map((k) => k.member_name || k.trustee_name));
  check(!options.some((k) => k.member_name === PEOPLE.spouse.name), "the other parent's key is not offered as a recipient");
  state.kidKeyId = kidKey.id;
  state.robinKeyId = robinKey.id;
  const common = { ownerKey: state.keys.owner, passphrase: PEOPLE.owner.keyPass };
  await sealDesignation(sessions.owner, { ...common, documentId: state.docs.will.id, targetKey: kidKey, memberId: kidKey.member_id });
  await sealDesignation(sessions.owner, { ...common, documentId: state.docs.will.id, targetKey: robinKey, trusteeId: robinKey.trustee_id });
  await sealDesignation(sessions.owner, { ...common, documentId: state.docs.accounts.id, targetKey: robinKey, trusteeId: robinKey.trustee_id });
  const directory = await sessions.owner.get('api/continuity/directory');
  const will = directory.documents.find((d) => d.title === TITLES.will);
  const accounts = directory.documents.find((d) => d.title === TITLES.accounts);
  check(will?.designations.length === 2 && will.designations.every((d) => d.sealed), 'Will: sealed for Kit and Robin', will);
  check(accounts?.designations.length === 1 && accounts.designations[0].sealed && accounts.designations[0].trustee_id, 'Account instructions: sealed for Robin only', accounts);
  check(!directory.documents.some((d) => d.title === TITLES.medical), 'the owner-only medical directive has no designation');
  await expectFailure('kid cannot read a document it holds only a sealed designation on',
    () => sessions.kid.get(`api/documents/${state.docs.will.id}`), /40[34]/);
});

phase('arm', '§6.6 + §7.3-7.6 packet, contact verification, reachability, arming, I\'m here', async () => {
  profiles.owner = await newProfile(browser, { cookie: sessions.owner.cookie });
  const item = await armViaContinuityPage({
    who: 'operator', session: sessions.owner, page: profiles.owner.page, reminderEmail: MAIL.owner,
    recipients: [PEOPLE.kid.name, TRUSTEES.recipient.name], packetDocs: [TITLES.will, TITLES.accounts],
    witnesses: [TRUSTEES.witness.name, TRUSTEES.witness2.name], letter: LETTER, kidEmail: MAIL.kid, prefix: 'operator'
  });
  state.switchId = item.id;
  check(item.status === 'armed' && Number(item.interval_days) === 30 && Number(item.grace_period_days) === 7, 'switch armed with 30/7 cadence', item);
  const packet = await sessions.owner.get(`api/continuity/switch/${item.id}/packet`);
  const packets = sql(`SELECT id, status, version_number FROM continuity_packet_versions WHERE switch_id = $1`, [item.id]);
  check(packets.filter((p) => p.status === 'active').length === 1, 'exactly one active packet version', packets);
  const failed = sqlOne(`SELECT COUNT(*)::int AS n FROM continuity_notification_outbox WHERE switch_id = $1 AND status IN ('failed','blocked_configuration')`, [item.id]);
  check(failed.n === 0, 'no failed or blocked outbox rows after arming', failed);
  check(packet.witnesses?.length === 2, 'packet names both witness trustees', packet.witnesses);
  state.letterId = item.letter_document_id;
  evidence('arm/switch.json', { switch_id: item.id, packet_version: packets.find((p) => p.status === 'active'), next_checkin_due_at: item.next_checkin_due_at, mailboxes: MAIL });

  // Operator-control branch once: I'm here starts a fresh cycle.
  const before = item;
  await profiles.owner.page.click('[data-switch-action="check-in"]');
  await profiles.owner.page.waitForFunction(() => /Check-in recorded/.test(document.getElementById('switch-message').textContent));
  const after = await switchFor(sessions.owner);
  check(Number(after.schedule_cycle) === Number(before.schedule_cycle) + 1 && after.status === 'armed', "I'm here starts a fresh cycle", { before: before.schedule_cycle, after: after.schedule_cycle });
});

phase('scenarioA', '§9 approaching reminder and email check-in', async () => {
  const item = await switchFor(sessions.owner);
  const at = minutesAfter(new Date(item.next_checkin_due_at).getTime() - 7 * DAY, 1);
  const result = simulateAt(at);
  evidence('scenarioA/simulate.json', result);
  const mail = await waitForMail({ to: MAIL.owner, subject: /gentle Home Source check-in/ });
  const link = linkFrom(mail, 'check-in.html');
  check(link.origin + link.pathname === `${CONFIG.appUrl}check-in.html`, 'reminder links to the Homebase /source/ check-in page', link.pathname);
  const leaks = [TITLES.will, TITLES.accounts, PEOPLE.kid.name, TRUSTEES.recipient.name, MARKERS.letter].filter((s) => mail.text.includes(s));
  check(leaks.length === 0, 'reminder has no document or recipient details', leaks);
  evidence('scenarioA/reminder.txt', `${mail.subject}\n\n${mail.text}`);

  const visitor = await newProfile(browser);
  await openSessionless(visitor.page, link.url);
  await visitor.page.locator('#checkin-button').waitFor({ state: 'visible' });
  await visitor.page.click('#checkin-button');
  await visitor.page.waitForFunction(() => document.getElementById('summary').textContent.includes("You're checked in"));
  check((await visitor.context.cookies()).every((c) => c.name !== 'hs_session'), 'email check-in creates no Home Source session');
  const after = await switchFor(sessions.owner);
  check(after.status === 'armed' && Number(after.schedule_cycle) === Number(item.schedule_cycle) + 1
    && new Date(after.next_checkin_due_at) > new Date(), 'switch returned to a healthy future cycle', after);
  await openSessionless(visitor.page, link.url);
  await visitor.page.waitForFunction(() => document.getElementById('summary').textContent !== 'Checking this one-time link…');
  check(/unavailable/.test(await visitor.page.textContent('#summary')), 'the used check-in link is unavailable');
  await expectHidden(visitor.page, '#checkin-button', "a used check-in link does not show an I'm here button");
  await visitor.context.close();
});

// Grace expiry → witness window. Returns the run row once the window has started.
async function graceToWitnessWindow(session, label, witnessMails) {
  const item = await switchFor(session);
  const at = minutesAfter(new Date(item.next_checkin_due_at).getTime() + Number(item.grace_period_days) * DAY, 1);
  const result = simulateAt(at);
  evidence(`${label}/simulate-grace.json`, result);
  check(result.state.delivery_runs_created === 1, `${label}: grace expiry created one delivery run`, result.state);
  const queued = sqlOne(`SELECT event_type FROM continuity_events WHERE switch_id = $1 AND event_type = 'delivery.trustees_queued' AND schedule_cycle = $2`, [item.id, item.schedule_cycle]);
  check(!!queued, `${label}: run entered trustee_notification_pending (delivery.trustees_queued)`);
  const links = [];
  for (const address of witnessMails) {
    const mail = await waitForMail({ to: address, subject: /continuity check needs your attention/ });
    const leaks = [TITLES.will, TITLES.accounts, PEOPLE.kid.name, TRUSTEES.recipient.name, MARKERS.letter, 'fingerprint', 'private key']
      .filter((s) => mail.text.toLowerCase().includes(s.toLowerCase()));
    check(leaks.length === 0, `${label}: witness notice to ${address} reveals no letter, document, holder, or key data`, leaks);
    links.push(linkFrom(mail, 'trustee-action.html'));
    evidence(`${label}/witness-${address}.txt`, `${mail.subject}\n\n${mail.text}`);
  }
  const run = runFor(item.id);
  check(run.status === 'trustee_window', `${label}: run is in trustee_window after witness delivery`, run.status);
  const window = new Date(run.trustee_action_deadline_at) - new Date(run.trustee_window_started_at);
  check(window === 72 * 60 * 60_000, `${label}: witness action deadline is 72 hours`, { started: run.trustee_window_started_at, deadline: run.trustee_action_deadline_at });
  const grants = sqlOne(`SELECT COUNT(*)::int AS n FROM continuity_delivery_grants WHERE delivery_run_id = $1`, [run.id]);
  check(grants.n === 0, `${label}: no recipient grant exists during the witness window`, grants);
  return { item, run, links };
}

phase('scenarioBpause', '§10.1-10.5 boundary notice, witness window, witness pause, owner recovery', async () => {
  const kidBefore = (await mailTo(MAIL.kid)).length;
  const robinBefore = (await mailTo(MAIL.trustee)).length;
  const { item, run, links } = await graceToWitnessWindow(sessions.owner, 'scenarioB-pause', [MAIL.witness, MAIL.witness2]);
  const notice = await waitForMail({ to: MAIL.owner, subject: /check-in needs your attention/ });
  check(/no beneficiary grant was created/.test(notice.text) && !/token=/.test(notice.text), 'owner boundary notice received, with no link and no grant', notice.subject);
  check((await mailTo(MAIL.kid)).length === kidBefore && (await mailTo(MAIL.trustee)).length === robinBefore, 'no recipient received a document link during the window');
  const switchRow = await switchFor(sessions.owner);
  check(switchRow.status === 'trustee_window', 'switch shows trustee_window', switchRow.status);
  await profiles.owner.page.goto('continuity.html');
  await profiles.owner.page.waitForFunction(() => /witness deadline/.test(document.getElementById('switch-summary').textContent));
  await shot(profiles.owner.page, 'scenarioB-01-trustee-window');

  const wren = await newProfile(browser);
  await openSessionless(wren.page, links[0].url);
  await wren.page.locator('#pause-button').waitFor({ state: 'visible' });
  const witnessPage = await wren.page.content();
  check(![TITLES.will, PEOPLE.kid.name, TRUSTEES.recipient.name, MARKERS.letter].some((s) => witnessPage.includes(s)) && !(await wren.page.$('nav')),
    'witness page reveals nothing and has no app navigation');
  await wren.page.click('#pause-button');
  await wren.page.waitForFunction(() => /pause is now in place/.test(document.getElementById('summary').textContent));
  check(wren.page.__dialogs.some((d) => d.type === 'confirm'), 'witness confirmed the one-time pause');
  await shot(wren.page, 'scenarioB-02-witness-paused');
  const paused = runFor(item.id);
  check(paused.status === 'trustee_paused' && paused.pause_deadline_at, 'run shows trustee_paused with a pause deadline', paused);
  const otherTokens = sql(`SELECT consumed_at, replaced_at FROM continuity_trustee_action_tokens WHERE delivery_run_id = $1`, [run.id]);
  check(otherTokens.filter((t) => t.consumed_at).length === 1 && otherTokens.filter((t) => !t.consumed_at).every((t) => t.replaced_at),
    'the other witness token was invalidated', otherTokens);
  const wade = await newProfile(browser);
  await openSessionless(wade.page, links[1].url);
  await wade.page.waitForFunction(() => document.getElementById('summary').textContent !== 'Checking this private witness link…');
  check(/already in place/.test(await wade.page.textContent('#summary')), 'second witness sees the existing pause');
  await expectHidden(wade.page, '#pause-button', 'second witness is not offered another pause button');
  await wade.context.close();

  // The owner proves they are here from the Continuity page.
  await profiles.owner.page.goto('continuity.html');
  await profiles.owner.page.locator('[data-switch-action="recover"]').waitFor();
  profiles.owner.page.__nextPrompt = PEOPLE.owner.login;
  await profiles.owner.page.click('[data-switch-action="recover"]');
  await profiles.owner.page.waitForFunction(() => /Delivery stopped/.test(document.getElementById('switch-message').textContent), null, { timeout: 30_000 });
  const recovered = await switchFor(sessions.owner);
  check(recovered.status === 'armed' && Number(recovered.schedule_cycle) === Number(item.schedule_cycle) + 1, "owner's I'm here — stop delivery re-armed a fresh cycle", recovered);
  check(runFor(item.id).status === 'owner_recovered', 'paused run is owner_recovered');
  await openSessionless(wren.page, links[0].url);
  await wren.page.waitForFunction(() => document.getElementById('summary').textContent !== 'Checking this private witness link…');
  check(/unavailable/.test(await wren.page.textContent('#summary')), 'witness link is unavailable after owner recovery');
  await expectHidden(wren.page, '#pause-button', 'an unavailable witness link shows no pause button');
  await wren.context.close();
});

phase('scenarioBrelease', '§10.6 no-pause branch: window expires, recipient grants and links', async () => {
  const witnessBefore = (await mailTo(MAIL.witness)).length + (await mailTo(MAIL.witness2)).length;
  const { item, run, links } = await graceToWitnessWindow(sessions.owner, 'scenarioB-release', [MAIL.witness, MAIL.witness2]);
  state.witnessTokenForNegative = links[0].token;
  await waitForMail({ to: MAIL.owner, subject: /check-in needs your attention/ });
  const result = simulateAt(new Date(new Date(run.trustee_action_deadline_at).getTime() + 1000));
  evidence('scenarioB-release/simulate-deadline.json', result);
  check(result.state.delivery_runs_released === 1, 'window expiry released the run to recipient delivery once', result.state);
  check(result.state.grants_created === 2 && result.state.active_grants === 2, 'two recipient grants activated', result.state);
  const grants = sql(`SELECT id, member_id, trustee_id, status, expires_at, destination_snapshot FROM continuity_delivery_grants g WHERE delivery_run_id = $1 ORDER BY id`, [run.id]);
  evidence('scenarioB-release/grants.json', grants);
  const witnessIds = [state.trustees.witness.id, state.trustees.witness2.id].map(Number);
  check(grants.length === 2 && grants.some((g) => g.member_id) && grants.some((g) => Number(g.trustee_id) === Number(state.trustees.recipient.id))
    && !grants.some((g) => witnessIds.includes(Number(g.trustee_id))), 'grants exist only for the sealed recipients (Kit, Robin)', grants);
  const released = runFor(item.id);
  check(released.status === 'delivery_active' && released.first_grant_activated_at, 'run is delivery_active', released.status);
  const kidMail = await waitForMail({ to: MAIL.kid, subject: /private Home Source delivery is ready/ });
  const robinMail = await waitForMail({ to: MAIL.trustee, subject: /private Home Source delivery is ready/ });
  state.links.kid = linkFrom(kidMail, 'recipient-delivery.html');
  state.links.robin = linkFrom(robinMail, 'recipient-delivery.html');
  check(kidMail.to.length === 1 && robinMail.to.length === 1, 'one fresh delivery link per recipient mailbox');
  const afterWitness = (await mailTo(MAIL.witness)).length + (await mailTo(MAIL.witness2)).length;
  check(afterWitness === witnessBefore + 2, 'witnesses received only the window notice, no delivery link', { witnessBefore, afterWitness });
  check([TITLES.will, TITLES.accounts, MARKERS.letter].every((s) => !kidMail.text.includes(s)), 'delivery mail carries no document details');
  evidence('scenarioB-release/delivery-mail.txt', `${kidMail.subject}\n\n${kidMail.text}`);
  await expectFailure('owner recovery is refused after the first grant activates',
    () => sessions.owner.post(`api/continuity/switch/${item.id}/recover`, { current_passphrase: PEOPLE.owner.login, operation_key: `late-${Date.now()}` }),
    /unavailable after recipient delivery activation/);
});

phase('scenarioC', '§11 recipient doorway, local unlock (passphrase and PRF), reissue, negatives', async () => {
  // Kit: own logged-out profile, passphrase-protected key.
  profiles.kid = await newProfile(browser);
  const kidItems = await openDelivery(profiles.kid.page, state.links.kid.url);
  check(JSON.stringify(kidItems) === JSON.stringify(['Private document 1', 'Private document 2']), 'Kit sees only "Private document N" before unlock', kidItems);
  const html = await profiles.kid.page.content();
  check(!(await profiles.kid.page.$('nav, [data-nav-page], script[src="nav.js"]')) && ![TITLES.will, TITLES.accounts, 'the-letter'].some((s) => html.includes(s)),
    'doorway has no Home Source navigation and no titles or filenames');
  check(!new URL(profiles.kid.page.url()).searchParams.get('token'), 'raw token removed from the address bar after exchange');
  await shot(profiles.kid.page, 'scenarioC-01-kid-minimal');
  await sessionStorageBearer(profiles.kid.page);
  await profiles.kid.page.reload();
  await profiles.kid.page.waitForFunction(() => !document.getElementById('items').hidden);
  const kidGrant = sqlOne(`SELECT id FROM continuity_delivery_grants WHERE member_id IS NOT NULL ORDER BY id DESC LIMIT 1`);
  const consumed = sqlOne(`SELECT COUNT(*) FILTER (WHERE consumed_at IS NOT NULL)::int AS consumed, (SELECT COUNT(*)::int FROM continuity_delivery_sessions WHERE delivery_grant_id = $1) AS sessions FROM continuity_delivery_tokens WHERE delivery_grant_id = $1`, [kidGrant.id]);
  check(consumed.consumed === 1 && consumed.sessions === 1, 'refresh resumed the 60-minute session without re-consuming the link', consumed);
  const kidUnlock = await unlockAll(profiles.kid.page, { passphrase: PEOPLE.kid.keyPass });
  check(!kidUnlock.error, 'Kit unlocked every item locally with the key passphrase', kidUnlock.error);
  const kidNames = kidUnlock.files.map((f) => f.name).sort();
  check(JSON.stringify(kidNames) === JSON.stringify(['the-letter.txt', 'will.txt']), 'Kit received the Letter and the Will only', kidNames);
  check(kidUnlock.files.find((f) => f.name === 'the-letter.txt').text === LETTER, 'Kit: decrypted Letter matches the armed text');
  check(kidUnlock.files.find((f) => f.name === 'will.txt').text.includes(MARKERS.will), 'Kit: decrypted Will carries its marker');
  await shot(profiles.kid.page, 'scenarioC-02-kid-unlocked');

  // Robin: the same tab that registered the security key, PRF unlock.
  const robinItems = await openDelivery(profiles.recipient.page, state.links.robin.url);
  check(robinItems.length === 3, 'Robin sees three private items', robinItems);
  await sessionStorageBearer(profiles.recipient.page);
  const robinUnlock = await unlockAll(profiles.recipient.page, state.robinUnlock === 'passkey' ? { passkey: true } : { passphrase: TRUSTEES.recipient.pass });
  check(!robinUnlock.error, `Robin unlocked every item locally (${state.robinUnlock === 'passkey' ? 'WebAuthn PRF ceremony' : 'passphrase fallback'})`, robinUnlock.error);
  const robinNames = robinUnlock.files.map((f) => f.name).sort();
  check(JSON.stringify(robinNames) === JSON.stringify(['account-instructions.txt', 'the-letter.txt', 'will.txt']), 'Robin received Letter, Will, and Account instructions', robinNames);
  check(robinUnlock.files.find((f) => f.name === 'account-instructions.txt').text.includes(MARKERS.accounts), 'Robin: Account instructions marker correct');
  check(robinUnlock.files.every((f) => !f.text.includes(MARKERS.medical)), 'the owner-only medical directive was not delivered');
  await shot(profiles.recipient.page, 'scenarioC-03-robin-unlocked');

  // A normal Home Source login is not a recipient session.
  for (const role of ['owner', 'kid']) {
    const res = await sessions[role].raw('GET', 'api/continuity/recipient/manifest');
    check(res.status === 404 && res.json()?.error === 'This private delivery is unavailable', `${PEOPLE[role].name}'s app session cannot read recipient endpoints`, res.status);
  }
  const bearer = await profiles.kid.page.evaluate(() => sessionStorage.getItem('homesource-recipient-delivery-bearer'));
  const crossApp = await request('GET', 'api/documents', { headers: { authorization: `Bearer ${bearer}` } });
  check(crossApp.status === 401, 'a recipient bearer cannot use the family vault API', crossApp.status);

  // Reopen the consumed link in a fresh profile; request a replacement.
  const reopen = await newProfile(browser);
  await openDelivery(reopen.page, state.links.kid.url);
  check(/unavailable/.test(await reopen.page.textContent('#summary')) && await reopen.page.isVisible('#reissue-button'), 'a consumed link does not exchange again and offers a replacement');
  await expectHidden(reopen.page, '#unlock', 'a failed exchange shows no unlock form');
  const robinMailBefore = (await mailTo(MAIL.trustee)).length;
  await reopen.page.click('#reissue-button');
  await reopen.page.waitForFunction(() => /replacement link will be sent/.test(document.getElementById('summary').textContent));
  await reopen.context.close();
  const revokedSessions = sqlOne(`SELECT COUNT(*) FILTER (WHERE revoked_at IS NULL)::int AS live FROM continuity_delivery_sessions WHERE delivery_grant_id = $1`, [kidGrant.id]);
  check(revokedSessions.live === 0, "Kit's prior live recipient session was revoked", revokedSessions);
  await profiles.kid.page.reload();
  await profiles.kid.page.waitForFunction(() => document.getElementById('summary').textContent.length > 30 && document.getElementById('items').hidden);
  const expiredText = await profiles.kid.page.textContent('#summary');
  check(/Re-open the original link/.test(expiredText), 'refresh without a raw token says to reopen the original email link', expiredText);
  await expectHidden(profiles.kid.page, '#reissue-button', 'expired-session page does not offer a resend it cannot queue (§11.6)');
  const worker = startUnitAndJournal('home-source-continuity-outbox.service');
  evidence('scenarioC/outbox-worker.log', worker.journal);
  const replacement = await waitForMail({ to: MAIL.kid, subject: /replacement private Home Source link/ });
  const grantAddress = sqlOne(`SELECT destination_snapshot FROM continuity_delivery_grants WHERE id = $1`, [kidGrant.id]);
  check(replacement.to.length === 1 && replacement.to[0] === MAIL.kid && grantAddress.destination_snapshot === MAIL.kid, 'replacement went only to the grant\'s immutable verified mailbox', { to: replacement.to, grant: grantAddress });
  check((await mailTo(MAIL.trustee)).length === robinMailBefore, 'no other mailbox received the replacement');
  state.links.kidReplacement = linkFrom(replacement, 'recipient-delivery.html');

  // Old, cross-purpose, and fabricated tokens fail without revealing anything.
  const generic = (res) => res.status === 404 && JSON.stringify(res.json()) === JSON.stringify({ error: 'This private delivery is unavailable' });
  const probes = {
    'replaced original link': state.links.kid.token,
    'witness action token': state.witnessTokenForNegative,
    'fabricated token': PKICrypto.toBase64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, 'x')
  };
  for (const [label, token] of Object.entries(probes)) {
    const res = await request('POST', 'api/continuity/recipient/exchange', { body: { token } });
    check(generic(res), `${label} cannot exchange and reveals no metadata`, { status: res.status, body: res.json() });
  }
  const crossCheckin = await request('POST', 'api/continuity/check-in/validate', { body: { token: state.links.robin.token } });
  check(crossCheckin.status === 404, 'a recipient token is not a check-in token', crossCheckin.status);
  const itemWithCookie = await sessions.owner.raw('GET', 'api/continuity/recipient/items/1');
  check(generic(itemWithCookie), 'app cookie cannot read a recipient item', itemWithCookie.status);
});

phase('smtpFailure', '§12.4 controlled SMTP failure, visible failure, Retry notifications', async () => {
  // Kit asks for a fresh link while the relay is denied.
  setRelayReachable(false);
  try {
    const reissue = await request('POST', 'api/continuity/recipient/reissue', { body: { token: state.links.kidReplacement.token } });
    check(reissue.status === 202, 'replacement request accepted while the relay is down', reissue.status);
    const first = startUnitAndJournal('home-source-continuity-outbox.service');
    evidence('smtpFailure/outbox-worker-relay-down.log', first.journal);
    const row = () => sqlOne(`SELECT o.id, o.status, o.attempt_count, o.next_attempt_at, o.last_error_class FROM continuity_notification_outbox o
      JOIN continuity_delivery_grants g ON g.id = o.delivery_grant_id WHERE g.member_id IS NOT NULL AND o.notification_type = 'recipient_delivery' ORDER BY o.id DESC LIMIT 1`);
    let current = row();
    check(current.status === 'pending' && current.attempt_count >= 1 && current.last_error_class, 'first failed attempt is recorded and scheduled for retry', current);
    deviate('A relay outage is retryable: the row stays "pending" with an error class until its sixth attempt, so the Retry notifications control (failed/blocked rows only) appears only after the backoff is exhausted. The drill walks the 15m/1h/6h/24h backoff with the simulation driver.');
    for (let attempt = 0; attempt < 8 && current.status !== 'failed'; attempt += 1) {
      simulateAt(new Date(new Date(current.next_attempt_at).getTime() + 1000));
      current = row();
    }
    check(current.status === 'failed' && current.attempt_count === 6, 'after six attempts the row is visibly failed', current);
    await profiles.owner.page.goto('continuity.html');
    await profiles.owner.page.waitForFunction(() => /Mail:/.test(document.getElementById('switch-operations').textContent));
    const retryVisible = await profiles.owner.page.locator('[data-retry-outbox]').isVisible();
    await shot(profiles.owner.page, 'smtpFailure-01-after-failure');
    setRelayReachable(true);
    if (retryVisible) {
      check(true, 'the failed recipient delivery is visible with a Retry notifications control');
      await profiles.owner.page.click('[data-retry-outbox]');
      await profiles.owner.page.waitForFunction(() => /queued for retry/.test(document.getElementById('switch-message').textContent));
      check(/1 notification item queued/.test(await profiles.owner.page.textContent('#switch-message')), 'parent Retry notifications re-queued the failed row');
    } else {
      finding('the failed recipient delivery is visible with a Retry notifications control', {
        operations: (await sessions.owner.get('api/continuity/switch')).operations.outbox, row: current.status
      });
      deviate('No Retry notifications control was shown for the failed recipient delivery; the drill calls the same parent API the control uses (POST /api/continuity/switch/:id/outbox/retry).');
      const retried = await sessions.owner.post(`api/continuity/switch/${state.switchId}/outbox/retry`, {});
      check(retried.retry_count === 1, 'parent retry API re-queued the failed recipient delivery', retried);
    }
  } finally {
    setRelayReachable(true);
  }
  const worker = startUnitAndJournal('home-source-continuity-outbox.service');
  evidence('smtpFailure/outbox-worker-relay-restored.log', worker.journal);
  const mail = await waitForMail({ to: MAIL.kid, subject: /replacement private Home Source link/ });
  state.links.kidLatest = linkFrom(mail, 'recipient-delivery.html');
  check(true, 'replacement delivered after the relay was restored');
});

phase('backupBefore', '§13.1-13.2 backup before expiry: contents and secret scan', async () => {
  await backupAndScan('before-expiry');
});

phase('scenarioD', '§12.1-12.3 one-year grant expiry, session revocation, timeline hygiene', async () => {
  // Live sessions: Kit exchanges the newest link; Robin's tab is still live.
  const items = await openDelivery(profiles.kid.page, state.links.kidLatest.url);
  check(items.length === 2, 'Kit has a live recipient session before expiry', items);
  await sessionStorageBearer(profiles.kid.page);
  // Leave one replacement queued but unsent so expiry must supersede it.
  await request('POST', 'api/continuity/recipient/reissue', { body: { token: state.links.robin.token } });
  const grants = sql(`SELECT id, expires_at FROM continuity_delivery_grants WHERE status = 'active' ORDER BY expires_at DESC`);
  const at = new Date(new Date(grants[0].expires_at).getTime() + 1000);
  const result = simulateAt(at);
  evidence('scenarioD/simulate-expiry.json', result);
  check(result.state.grants_expired === 2 && result.state.runs_completed === 1, 'both grants expired and the run completed', result.state);
  const after = sql(`SELECT g.status,
      (SELECT COUNT(*)::int FROM continuity_delivery_sessions s WHERE s.delivery_grant_id = g.id AND s.revoked_at IS NULL) AS live_sessions,
      (SELECT COUNT(*)::int FROM continuity_delivery_tokens t WHERE t.delivery_grant_id = g.id AND t.consumed_at IS NULL AND t.replaced_at IS NULL) AS live_links,
      (SELECT COUNT(*)::int FROM continuity_notification_outbox o WHERE o.delivery_grant_id = g.id AND o.status IN ('pending','deferred','claimed')) AS queued
    FROM continuity_delivery_grants g ORDER BY g.id`);
  check(after.every((g) => g.status === 'expired' && g.live_sessions === 0 && g.live_links === 0 && g.queued === 0),
    'every grant expired with no live session, link, or queued mail', after);
  const superseded = sqlOne(`SELECT o.status, o.last_error_class FROM continuity_notification_outbox o JOIN continuity_delivery_grants g ON g.id = o.delivery_grant_id WHERE g.trustee_id IS NOT NULL ORDER BY o.id DESC LIMIT 1`);
  check(superseded.status === 'superseded' || superseded.status === 'sent', 'the queued replacement was superseded (or had already been sent)', superseded);
  const item = await switchFor(sessions.owner);
  check(item.status === 'delivery_complete' && runFor(item.id).status === 'delivery_complete', 'run and switch are delivery_complete', item.status);
  await profiles.kid.page.reload();
  await profiles.kid.page.waitForFunction(() => document.getElementById('items').hidden && document.getElementById('summary').textContent.length > 30);
  check(/Re-open the original link/.test(await profiles.kid.page.textContent('#summary')), "Kit's live session was revoked at expiry");
  for (const link of [state.links.kidLatest, state.links.robin]) {
    const res = await request('POST', 'api/continuity/recipient/exchange', { body: { token: link.token } });
    check(res.status === 404, 'links no longer work after expiry', res.status);
  }
  const timeline = await sessions.owner.get(`api/continuity/switch/${item.id}/timeline`);
  evidence('scenarioD/timeline.json', timeline);
  const serialized = JSON.stringify(timeline);
  const types = new Set((timeline.events || timeline || []).map((e) => e.event_type || e.type));
  for (const type of ['delivery.trustee_paused', 'switch.owner_recovered', 'delivery.recipient_grants_activated', 'delivery.recipient_reissue_queued', 'delivery.recipient_grant_expired']) {
    check(types.has(type), `timeline records ${type}`, [...types]);
  }
  const forbidden = [...knownSecrets(), ...Object.values(TITLES), ...Object.values(MARKERS), 'the-letter.txt', 'will.txt', 'account-instructions.txt', state.docs.will.dekB64];
  const leaks = forbidden.filter((s) => s && serialized.includes(s));
  check(leaks.length === 0, 'timeline has no raw tokens, titles, filenames, keys, DEKs, or plaintext', leaks.map(redact));
});

phase('backupAfter', '§13 backup after expiry, Homebase backup action, recovery-runbook decrypt', async () => {
  const { root } = await backupAndScan('after-expiry');
  // Recovery runbook: recover one invented document using only the recovery words, with the
  // recovery CLI Homebase deployed (on the host's runtime), from a copy of the archive.
  const remote = `/tmp/recovery-${Date.now()}`;
  run('docker', ['cp', root, `${CONFIG.container}:${remote}`]);
  const recovered = run('docker', ['exec', '-w', CONFIG.appDir, CONFIG.container, 'node', 'bin/decrypt-backup-encrypted-doc.js',
    '--database', `${remote}/database.json`, '--backup-root', remote, '--mode', 'pki',
    '--recovery-code', state.mnemonic, '--doc-id', String(state.docs.will.id), '--out-dir', `${remote}/out`], { allowFail: true });
  const text = hostSh(`cat ${remote}/out/* 2>/dev/null; rm -rf ${remote}`).stdout;
  evidence('backup/recovery-cli.txt', recovered.stdout + recovered.stderr);
  if (recovered.status === 0 && text.includes(MARKERS.will)) {
    check(true, 'recovery-runbook CLI decrypted the Will from the backup using only the recovery words');
  } else {
    finding('recovery-runbook CLI decrypts a current (multi-holder) PKI document from the backup', (recovered.stderr || recovered.stdout).trim());
  }

  const job = hostSh(`job.sh /api/apps/home-source/backup/execute`, { allowFail: true });
  evidence('backup/homebase-backup-job.txt', job.stdout + job.stderr);
  check(job.status === 0 && /completed/.test(job.stdout), 'Homebase backup action completed for home-source', job.stdout.slice(-300));
  const archives = hostSh(`ls -1t /var/lib/sovereign-home/backups/home-source 2>/dev/null | head -3; find /var/lib -path '*backup*' -name '*home-source*' -newer /tmp/install.log 2>/dev/null | head -5`).stdout;
  evidence('backup/homebase-backup-files.txt', archives);
});

async function backupAndScan(label) {
  const result = await sessions.owner.post('api/backup/export', { encrypted: false });
  const res = await sessions.owner.raw('GET', `api/backup/download/${encodeURIComponent(result.file)}`);
  check(res.status === 200 && res.buffer.length > 1000, `${label}: backup archive downloaded`, { status: res.status, bytes: res.buffer.length });
  const dir = path.join(EVIDENCE, 'backup', label);
  fs.mkdirSync(dir, { recursive: true });
  const archive = path.join(dir, result.file);
  fs.writeFileSync(archive, res.buffer);
  run('tar', ['-xzf', archive, '-C', dir]);
  const root = path.join(dir, fs.readdirSync(dir).find((f) => fs.statSync(path.join(dir, f)).isDirectory()));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  evidence(`backup/${label}-manifest.json`, manifest);
  const sha = run('shasum', ['-a', '256', archive]).stdout.trim();
  evidence(`backup/${label}-sha256.txt`, sha);
  for (const table of ['continuity_switches', 'continuity_delivery_runs', 'continuity_delivery_grants', 'continuity_delivery_tokens', 'continuity_notification_outbox', 'continuity_events']) {
    check(manifest.tables.includes(table), `${label}: backup includes ${table}`);
  }
  const db = JSON.parse(fs.readFileSync(path.join(root, 'database.json'), 'utf8'));
  const encryptedDocs = (db.documents || []).filter((d) => d.encryption_mode === 'pki');
  const storedFiles = (db.document_files || []).filter((f) => encryptedDocs.some((d) => Number(d.id) === Number(f.document_id)));
  check(storedFiles.length >= 4 && storedFiles.every((f) => fs.existsSync(path.join(root, f.stored_filename))),
    `${label}: every encrypted artifact referenced by the database is in the archive`, storedFiles.map((f) => f.stored_filename));
  // Hashes may appear; raw bearers, private keys, DEKs, passphrases, and plaintext must not.
  const forbidden = [...knownSecrets(), ...Object.values(MARKERS), LETTER];
  const leaks = new Set();
  const walk = (p) => {
    for (const entry of fs.readdirSync(p)) {
      const full = path.join(p, entry);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (full !== archive) {
        const content = fs.readFileSync(full).toString('latin1');
        for (const secret of forbidden) if (content.includes(secret)) leaks.add(`${path.relative(root, full)}: ${redact(secret).slice(0, 12)}`);
      }
    }
  };
  walk(root);
  check(leaks.size === 0, `${label}: archive contains no raw links, bearers, private keys, DEKs, passphrases, or plaintext (${forbidden.length} secrets scanned)`, [...leaks]);
  fs.rmSync(archive);
  return { root, manifest };
}

phase('pauseExpiry', '§10 alternate branch on a second parent: witness pause expires and releases once', async () => {
  const sam = sessions.spouse;
  const willa = await inviteTrustee(sam, TRUSTEES.witness3);
  const willaProfile = await newProfile(browser);
  await registerTrusteeWithPassphrase(willaProfile, willa.link, 'Willa key', TRUSTEES.witness3.pass);
  profiles.spouse = await newProfile(browser, { cookie: sam.cookie });
  // The verified contact belongs to Kit, not to Pat's switch, so Sam's switch reuses it.
  const reuse = (await sam.get('api/continuity/directory')).members.find((m) => m.name === PEOPLE.kid.name);
  const item = await armViaContinuityPage({
    who: 'spouse', session: sam, page: profiles.spouse.page, reminderEmail: MAIL.spouse,
    recipients: [PEOPLE.kid.name], packetDocs: [], witnesses: [TRUSTEES.witness3.name],
    letter: SPOUSE_LETTER, kidEmail: null, prefix: 'spouse'
  });
  check(item.status === 'armed', "Sam's independent switch armed");
  const kidContact = (await sam.get('api/continuity/directory')).members.find((m) => m.name === PEOPLE.kid.name);
  check(kidContact.contact_status === 'verified' && kidContact.contact_address === MAIL.kid, "Kit's recipient-verified contact is reused for Sam's switch", { before: reuse?.contact_status ?? null, after: kidContact });
  const { run, links } = await graceToWitnessWindow(sam, 'pauseExpiry', [MAIL.witness3]);
  await waitForMail({ to: MAIL.spouse, subject: /check-in needs your attention/ });
  const first = await request('POST', 'api/continuity/trustee-action/pause', { body: { token: links[0].token } });
  check(first.status === 200 && first.json().replayed === false, 'Willa placed the one-time pause', first.json());
  const again = await request('POST', 'api/continuity/trustee-action/pause', { body: { token: links[0].token } });
  check(again.json()?.replayed === true && again.json().pause_deadline_at === first.json().pause_deadline_at, 'a second pause request does not extend the deadline', again.json());
  const paused = runFor(item.id);
  const releaseAt = new Date(new Date(paused.pause_deadline_at).getTime() + 1000);
  const result = simulateAt(releaseAt);
  evidence('pauseExpiry/simulate-release.json', result);
  check(result.state.delivery_runs_released === 1 && result.state.grants_created === 1, 'pause expiry released the run to recipient delivery once', result.state);
  const repeat = simulateAt(new Date(releaseAt.getTime() + 60_000));
  check(repeat.state.delivery_runs_released === 0 && repeat.state.grants_created === 0, 'a later run does not release or grant again', repeat.state);
  const resolution = sqlOne(`SELECT details FROM continuity_events WHERE switch_id = $1 AND event_type = 'delivery.trustee_window_resolved' ORDER BY id DESC LIMIT 1`, [item.id]);
  check(resolution?.details?.resolution === 'pause_expired', 'resolution recorded as pause_expired', resolution);
  const mail = await waitForMail({ to: MAIL.kid, subject: /private Home Source delivery is ready/ });
  const kidSpouse = await newProfile(browser);
  const items = await openDelivery(kidSpouse.page, linkFrom(mail, 'recipient-delivery.html').url);
  check(items.length === 1, "Kit's delivery from Sam contains only Sam's letter", items);
  const unlocked = await unlockAll(kidSpouse.page, { passphrase: PEOPLE.kid.keyPass });
  check(!unlocked.error && unlocked.files[0]?.text === SPOUSE_LETTER, "Kit decrypted Sam's letter locally", unlocked.error);
  await Promise.all([willaProfile.context.close(), kidSpouse.context.close()]);
});

// ── Runner ───────────────────────────────────────────────────────────────────

function writeReport(outcome, failure) {
  const passed = results.filter((r) => r.ok).length;
  const lines = [
    `# Feature 13 continuity acceptance drill — ${outcome.toUpperCase()}`, '',
    `- Run: ${stamp}`, `- Home Source commit installed by Homebase: ${state.installedCommit || 'unknown'}`,
    `- Checks: ${passed} passed, ${results.length - passed} failed (${results.filter((r) => r.finding).length} non-blocking findings)`, `- Mailboxes: ${Object.values(MAIL).join(', ')}`,
    failure ? `- Stopped at: ${failure}` : '', '',
    '## Deviations and notes', ...(deviations.length ? deviations.map((d) => `- [${d.phase}] ${d.text}`) : ['- none']), ''
  ];
  for (const p of phases) {
    const rows = results.filter((r) => r.phase === p.id);
    if (!rows.length) continue;
    lines.push(`## ${p.id} — ${p.title}`, '');
    for (const r of rows) lines.push(`- ${r.ok ? '✅' : r.finding ? '🟥 FINDING' : '❌'} ${r.label}${!r.ok && r.detail ? ` — \`${r.detail.slice(0, 300)}\`` : ''}`);
    lines.push('');
  }
  evidence('report.md', lines.join('\n'));
  evidence('report.json', { outcome, stamp, installedCommit: state.installedCommit, results, deviations });
}

async function main() {
  console.log(`Evidence: ${EVIDENCE}`);
  browser = await launchBrowser();
  let failure = null;
  try {
    for (const p of phases) {
      if (skip.has(p.id)) continue;
      currentPhase = p.id;
      console.log(`\n▶ ${p.id}: ${p.title}`);
      await p.fn();
      if (until === p.id) break;
    }
  } catch (err) {
    failure = `${currentPhase}: ${err.message}`;
    if (!(err instanceof DrillFailure)) {
      results.push({ phase: currentPhase, label: `unexpected error: ${redact(err.message)}`, ok: false });
      console.error(redact(err.stack || err.message));
    }
    for (const [name, profile] of Object.entries(profiles)) {
      await profile?.page?.screenshot({ path: path.join(EVIDENCE, 'screenshots', `failure-${name}.png`), fullPage: true }).catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
  }
  const findings = results.filter((r) => r.finding).length;
  const outcome = failure ? 'failed' : findings ? 'failed (findings)' : (until ? 'partial' : 'passed');
  writeReport(outcome, failure);
  console.log(`\n${outcome.toUpperCase()}: ${results.filter((r) => r.ok).length}/${results.length} checks. Report: ${path.join(EVIDENCE, 'report.md')}`);
  process.exitCode = failure || findings ? 1 : 0;
}

main();
