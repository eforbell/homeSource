'use strict';

(function () {
  const state = {
    me: null,
    members: [],
    keysByMember: new Map(),
    registration: null,
    passphraseMember: null,
  };

  const themeSelect = document.getElementById('theme-select');
  const membersList = document.getElementById('members-list');
  const keysList = document.getElementById('keys-list');
  const auditTbody = document.getElementById('audit-tbody');

  themeSelect.value = window.SourceTheme?.getPreference() || 'system';
  themeSelect.addEventListener('change', () => window.SourceTheme?.setPreference(themeSelect.value));

  document.querySelectorAll('[data-close-modal]').forEach((button) => {
    button.addEventListener('click', () => closeModal(button.getAttribute('data-close-modal')));
  });

  document.getElementById('add-member-btn').addEventListener('click', () => {
    document.getElementById('member-modal').classList.remove('hidden');
  });

  document.getElementById('save-member-btn').addEventListener('click', async () => {
    try {
      await API.post('api/members', {
        name: document.getElementById('new-member-name').value,
        role: document.getElementById('new-member-role').value,
        avatar_emoji: document.getElementById('new-member-avatar').value,
        passphrase: document.getElementById('new-member-pass').value || undefined,
      });
      closeModal('member-modal');
      toast('Member added', 'success');
      await loadMembersAndKeys();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  document.getElementById('save-passphrase-btn').addEventListener('click', async () => {
    const member = state.passphraseMember;
    if (!member || member.id !== state.me.id) {
      toast('You can only update your own passphrase', 'error');
      return;
    }

    const currentPassphrase = document.getElementById('current-passphrase').value || '';
    const newPassphrase = document.getElementById('new-passphrase').value || '';
    const confirmPassphrase = document.getElementById('confirm-new-passphrase').value || '';
    if (!newPassphrase || newPassphrase.length < 8) {
      toast('Use a passphrase with at least 8 characters', 'error');
      return;
    }
    if (newPassphrase !== confirmPassphrase) {
      toast('Passphrases do not match', 'error');
      return;
    }

    try {
      await API.post('api/auth/passphrase', {
        current_passphrase: currentPassphrase || undefined,
        new_passphrase: newPassphrase,
      });
      closeModal('passphrase-modal');
      toast('Login passphrase updated', 'success');
      await loadMembersAndKeys();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await API.post('api/auth/logout', {});
    location.href = './login';
  });

  async function init() {
    try {
      state.me = await API.get('api/auth/me');
    } catch {
      location.href = './login';
      return;
    }

    document.body.dataset.navRole = state.me.role || 'parent';
    document.getElementById('add-member-btn').style.display = state.me.role === 'parent' ? '' : 'none';

    if (state.me.role !== 'parent') {
      hideAuditSection();
    }

    await loadMembersAndKeys();
    if (state.me.role === 'parent') {
      await loadAudit();
    }
  }

  async function loadMembersAndKeys() {
    try {
      state.members = await API.get('api/members');
      renderMembers();
      await loadKeys();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function renderMembers() {
    const showMembers = state.me.role === 'parent' ? state.members : state.members.filter((member) => member.id === state.me.id);
    membersList.innerHTML = showMembers.map((member) => {
      const subtitle = member.id === state.me.id
        ? '<span class="badge badge-info">You</span>'
        : `<span class="text-xs text-muted">${member.role}</span>`;
      const keySummary = summarizeKeys(state.keysByMember.get(member.id) || []);
      const canChangeOwnPassphrase = member.id === state.me.id;
      const passphraseAction = canChangeOwnPassphrase
        ? `<button class="btn btn-sm" data-change-passphrase="${member.id}">${member.has_passphrase ? 'Change' : 'Set'} passphrase</button>`
        : '';
      return `
        <div class="flex-between mb-1" style="padding:0.75rem 0; border-bottom:1px solid var(--border); align-items:flex-start;">
          <div class="flex gap-1" style="align-items:center;">
            <span style="font-size:1.4rem;">${member.avatar_emoji}</span>
            <div>
              <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">
                <strong>${esc(member.name)}</strong>
                ${subtitle}
                ${member.has_passphrase ? '<span class="text-xs" style="color:var(--good);">🔑 Login passphrase</span>' : '<span class="text-xs text-muted">No login passphrase</span>'}
              </div>
              <div class="text-xs text-dim" style="margin-top:0.25rem;">${keySummary}</div>
            </div>
          </div>
          ${passphraseAction}
        </div>
      `;
    }).join('') || '<div class="text-dim text-sm">No household members yet.</div>';

    document.querySelectorAll('[data-change-passphrase]').forEach((button) => {
      button.addEventListener('click', () => {
        const memberId = Number(button.getAttribute('data-change-passphrase'));
        const member = state.members.find((entry) => entry.id === memberId);
        if (member) openPassphraseModal(member);
      });
    });
  }

  function openPassphraseModal(member) {
    state.passphraseMember = member;
    document.getElementById('passphrase-member-name').textContent = member.name || 'your account';
    document.getElementById('current-passphrase').value = '';
    document.getElementById('new-passphrase').value = '';
    document.getElementById('confirm-new-passphrase').value = '';
    const currentGroup = document.getElementById('current-passphrase-group');
    currentGroup.style.display = member.has_passphrase ? '' : 'none';
    document.getElementById('passphrase-modal').classList.remove('hidden');
    const focusId = member.has_passphrase ? 'current-passphrase' : 'new-passphrase';
    document.getElementById(focusId)?.focus();
  }

  async function loadKeys() {
    const visibleMembers = state.me.role === 'parent'
      ? state.members
      : state.members.filter((member) => member.id === state.me.id);

    const results = await Promise.all(visibleMembers.map(async (member) => {
      try {
        const keys = await API.get(`api/members/${member.id}/keys`);
        return [member.id, keys];
      } catch {
        return [member.id, []];
      }
    }));

    state.keysByMember = new Map(results);
    renderMembers();
    renderKeys();
  }

  function renderKeys() {
    const visibleMembers = state.me.role === 'parent'
      ? state.members
      : state.members.filter((member) => member.id === state.me.id);

    if (!visibleMembers.length) {
      keysList.innerHTML = '<div class="text-dim text-sm">No members available for key registration.</div>';
      return;
    }

    keysList.innerHTML = visibleMembers.map((member) => {
      const keys = state.keysByMember.get(member.id) || [];
      const canRegister = member.id === state.me.id;
      return `
        <div style="padding:0.85rem 0; border-bottom:1px solid var(--border);">
          <div class="flex-between gap-1" style="align-items:flex-start;">
            <div>
              <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">
                <strong>${esc(member.name)}</strong>
                <span class="text-xs text-muted">${member.role}</span>
                ${member.id === state.me.id ? '<span class="badge badge-info">Your keys</span>' : ''}
              </div>
              <div class="form-hint">${canRegister ? 'Choose a ceremony that feels easy to repeat and hard for anyone else to fake.' : 'Parents can review posture here. This member must sign in to register their own key.'}</div>
            </div>
            ${canRegister ? `<button class="btn btn-sm btn-primary" data-register-member="${member.id}">Register Key</button>` : ''}
          </div>
          <div style="margin-top:0.75rem;">
            ${keys.length ? keys.map((key) => renderKeyRow(member, key)).join('') : '<div class="text-dim text-sm">No encryption keys registered yet.</div>'}
          </div>
        </div>
      `;
    }).join('');

    document.querySelectorAll('[data-register-member]').forEach((button) => {
      button.addEventListener('click', () => {
        const memberId = Number(button.getAttribute('data-register-member'));
        const member = state.members.find((entry) => entry.id === memberId);
        if (member) openRegistrationModal(member);
      });
    });

    document.querySelectorAll('[data-verify-key]').forEach((button) => {
      button.addEventListener('click', () => verifyStoredFingerprint(Number(button.getAttribute('data-member-id')), Number(button.getAttribute('data-verify-key'))));
    });

    document.querySelectorAll('[data-revoke-key]').forEach((button) => {
      button.addEventListener('click', () => revokeKey(Number(button.getAttribute('data-member-id')), Number(button.getAttribute('data-revoke-key'))));
    });
  }

  function renderKeyRow(member, key) {
    const badges = [
      `<span class="badge ${key.protection_tier === 'hardware' ? 'badge-info' : (key.protection_tier === 'platform' ? 'badge-warn' : 'badge-muted')}">${key.protection_tier === 'hardware' ? 'Security key' : (key.protection_tier === 'platform' ? 'Passkey' : 'Passphrase')}</span>`,
      key.credential_verified ? '<span class="badge badge-info">Verified ceremony</span>' : '<span class="badge badge-muted">Unverified</span>',
      key.recovery_enabled ? '<span class="badge badge-info">Recovery set</span>' : '<span class="badge badge-muted">No recovery</span>',
    ].join(' ');

    const actionButtons = [
      `<button class="btn btn-sm" data-verify-key="${key.id}" data-member-id="${member.id}">Verify</button>`,
      (state.me.id === member.id)
        ? `<button class="btn btn-sm btn-danger" data-revoke-key="${key.id}" data-member-id="${member.id}">Revoke</button>`
        : '',
    ].join('');

    return `
      <div class="card" style="padding:0.85rem; margin-bottom:0.75rem;">
        <div class="flex-between gap-1" style="align-items:flex-start;">
          <div>
            <div style="font-weight:600;">${esc(key.label || 'Unnamed key')}</div>
            <div class="text-xs text-dim" style="margin-top:0.25rem;">Fingerprint ${esc(truncateFingerprint(key.key_fingerprint))}</div>
            <div class="text-xs text-dim" style="margin-top:0.2rem;">Created ${new Date(key.created_at).toLocaleDateString()}${key.last_used_at ? ` · Last used ${new Date(key.last_used_at).toLocaleDateString()}` : ''}</div>
            <div style="margin-top:0.5rem; display:flex; gap:0.35rem; flex-wrap:wrap;">${badges}</div>
          </div>
          <div class="flex gap-1" style="flex-wrap:wrap; justify-content:flex-end;">${actionButtons}</div>
        </div>
      </div>
    `;
  }

  function summarizeKeys(keys) {
    if (!keys.length) return 'No encryption keys yet';
    const verifiedCount = keys.filter((key) => key.credential_verified).length;
    const recoveryCount = keys.filter((key) => key.recovery_enabled).length;
    return `${keys.length} key${keys.length === 1 ? '' : 's'} · ${verifiedCount} verified · ${recoveryCount} with recovery`;
  }

  async function verifyStoredFingerprint(memberId, keyId) {
    const key = (state.keysByMember.get(memberId) || []).find((entry) => entry.id === keyId);
    if (!key) return toast('Key not found', 'error');
    try {
      const publicKeyRaw = PKICrypto.fromBase64(key.public_key);
      const localFingerprint = await PKICrypto.computeKeyFingerprint(publicKeyRaw);
      const result = await API.post(`api/members/${memberId}/keys/${keyId}/verify-fingerprint`, {
        expected_fingerprint: localFingerprint,
      });
      if (result.match) {
        toast('Server fingerprint matches the stored public key', 'success');
      } else {
        toast('Fingerprint mismatch detected', 'error');
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function getKeyDependencies(memberId, keyId) {
    return API.get(`api/members/${memberId}/keys/${keyId}/dependencies`);
  }

  function summarizeDependencyTitles(documents) {
    const titles = (Array.isArray(documents) ? documents : [])
      .map((doc) => String(doc?.title || '').trim())
      .filter(Boolean)
      .slice(0, 3);
    if (!titles.length) return '';
    return ` Affected: ${titles.join(', ')}${documents.length > titles.length ? ', …' : ''}.`;
  }

  async function revokeKey(memberId, keyId) {
    const key = (state.keysByMember.get(memberId) || []).find((entry) => entry.id === keyId);
    if (!key) return toast('Key not found', 'error');
    try {
      const dependencies = await getKeyDependencies(memberId, keyId);
      const unsafeDocs = Array.isArray(dependencies.documents)
        ? dependencies.documents.filter((doc) => doc.status === 'sole_active_holder')
        : [];
      const inconsistentDocs = Array.isArray(dependencies.documents)
        ? dependencies.documents.filter((doc) => doc.status === 'holder_metadata_inconsistent')
        : [];

      if (unsafeDocs.length) {
        toast(
          `You cannot revoke "${key.label || 'this key'}" yet. It is the sole active unlock holder for ${unsafeDocs.length} PKI-encrypted document${unsafeDocs.length === 1 ? '' : 's'}.${summarizeDependencyTitles(unsafeDocs)}`,
          'error'
        );
        return;
      }

      if (inconsistentDocs.length) {
        toast(
          `You cannot revoke "${key.label || 'this key'}" yet because encrypted document holder metadata is inconsistent.${summarizeDependencyTitles(inconsistentDocs)}`,
          'error'
        );
        return;
      }

      const dependencyCount = Number(dependencies.document_count || 0);
      const message = dependencyCount
        ? `Revoke "${key.label || 'this key'}"? It is referenced by ${dependencyCount} PKI-encrypted document${dependencyCount === 1 ? '' : 's'}, but each still has another active holder who can open it.${summarizeDependencyTitles(dependencies.documents || [])}`
        : `Revoke "${key.label || 'this key'}"? It is not currently referenced by any PKI-encrypted documents.`;
      if (!await showConfirm('Revoke Key', message)) {
        return;
      }

      const res = await fetch(`api/members/${memberId}/keys/${keyId}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || res.statusText);
      }
      toast('Key revoked', 'success');
      await loadMembersAndKeys();
      if (state.me.role === 'parent') await loadAudit();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function openRegistrationModal(member) {
    state.registration = {
      member,
      step: 'choose',
      pending: null,
      saved: null,
      recovery: null,
      method: null,
      passphrase: '',
      localFingerprint: null,
    };
    renderRegistrationModal();
    document.getElementById('key-registration-modal').classList.remove('hidden');
  }

  function closeRegistrationModal() {
    clearSensitiveRegistrationState();
    state.registration = null;
    document.getElementById('key-registration-modal')?.classList.add('hidden');
  }

  function clearSensitiveRegistrationState() {
    if (state.registration?.pending) {
      state.registration.pending.privateKey = null;
      state.registration.pending.prfOutput = null;
    }
    if (state.registration) {
      state.registration.passphrase = '';
    }
  }

  function renderRegistrationModal() {
    const modalBody = document.getElementById('key-registration-body');
    const modalActions = document.getElementById('key-registration-actions');
    const title = document.getElementById('key-modal-title');
    const subtitle = document.getElementById('key-modal-subtitle');
    const reg = state.registration;
    if (!reg) return;

    title.textContent = `Register Encryption Key for ${reg.member.name}`;

    if (reg.step === 'choose') {
      subtitle.textContent = 'Pick the protection method that feels simplest to repeat and gives you the highest confidence.';
      modalBody.innerHTML = `
        <div class="empty-state" style="padding:0; text-align:left;">
          <div class="form-group">
            <button class="btn btn-primary" id="choose-security-key" style="width:100%; justify-content:flex-start;">Hardware Security Key (recommended)</button>
            <div class="form-hint">Best for high confidence. Ideal if you use a YubiKey or similar security key.</div>
          </div>
          <div class="form-group">
            <button class="btn" id="choose-passkey" style="width:100%; justify-content:flex-start;">Passkey on this device</button>
            <div class="form-hint">Simple ceremony using your device or password manager. Good convenience, but often cloud-synced.</div>
          </div>
          <div class="form-group">
            <button class="btn" id="choose-passphrase" style="width:100%; justify-content:flex-start;">Passphrase fallback</button>
            <div class="form-hint">Works everywhere. Simpler to start, weaker against offline guessing than a verified security key.</div>
          </div>
        </div>
      `;
      modalActions.innerHTML = '<button class="btn" id="cancel-registration-btn">Cancel</button>';
      document.getElementById('cancel-registration-btn').addEventListener('click', closeRegistrationModal);
      document.getElementById('choose-security-key').addEventListener('click', () => startWebAuthnRegistration('security_key'));
      document.getElementById('choose-passkey').addEventListener('click', () => startWebAuthnRegistration('passkey'));
      document.getElementById('choose-passphrase').addEventListener('click', () => {
        reg.step = 'passphrase';
        renderRegistrationModal();
      });
      return;
    }

    if (reg.step === 'passphrase') {
      subtitle.textContent = 'Choose a passphrase you can re-enter later. We only use it to wrap your member key locally.';
      modalBody.innerHTML = `
        <div class="form-group">
          <label class="form-label">Passphrase</label>
          <input type="password" id="reg-passphrase" class="form-input" autocomplete="new-password">
          <div id="reg-passphrase-strength" style="display:none; margin-top:0.35rem;">
            <div style="display:flex; gap:3px; height:4px;">
              <div class="strength-seg" style="flex:1; border-radius:2px; background:var(--border);"></div>
              <div class="strength-seg" style="flex:1; border-radius:2px; background:var(--border);"></div>
              <div class="strength-seg" style="flex:1; border-radius:2px; background:var(--border);"></div>
              <div class="strength-seg" style="flex:1; border-radius:2px; background:var(--border);"></div>
            </div>
            <div id="reg-passphrase-strength-text" class="form-hint" style="margin-top:0.2rem;"></div>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Confirm passphrase</label>
          <input type="password" id="reg-passphrase-confirm" class="form-input" autocomplete="new-password">
        </div>
      `;
      modalActions.innerHTML = `
        <button class="btn" id="passphrase-back-btn">Back</button>
        <button class="btn btn-primary" id="passphrase-continue-btn">Generate Key</button>
      `;
      document.getElementById('passphrase-back-btn').addEventListener('click', () => {
        reg.step = 'choose';
        renderRegistrationModal();
      });
      document.getElementById('passphrase-continue-btn').addEventListener('click', preparePassphraseRegistration);
      bindPassphraseStrengthMeter();
      return;
    }

    if (reg.step === 'working') {
      subtitle.textContent = 'Keep this window open while we complete the ceremony.';
      modalBody.innerHTML = `<div class="empty-state"><div class="empty-state-icon">🔐</div><div class="empty-state-title">Working…</div><p>${esc(reg.message || 'Preparing your encryption key…')}</p></div>`;
      modalActions.innerHTML = '<button class="btn" id="cancel-registration-btn">Cancel</button>';
      document.getElementById('cancel-registration-btn').addEventListener('click', closeRegistrationModal);
      return;
    }

    if (reg.step === 'review') {
      subtitle.textContent = reg.pending.mode === 'webauthn'
        ? 'Your device ceremony succeeded. Save the wrapped key to Home Source and verify the fingerprint.'
        : 'Your passphrase-wrapped key is ready. Save it and verify the fingerprint.';
      modalBody.innerHTML = `
        <div class="modal-summary">
          <div class="modal-summary-row"><span class="k">Protection</span><span class="v">${reg.pending.mode === 'webauthn' ? (reg.method === 'security_key' ? 'Security key / external authenticator' : 'Passkey / local device') : 'Passphrase'}</span></div>
          <div class="modal-summary-row"><span class="k">Fingerprint</span><span class="v" style="font-size:0.85rem;">${esc(reg.localFingerprint)}</span></div>
        </div>
        <div class="form-group">
          <label class="form-label">Key label</label>
          <input type="text" id="reg-key-label" class="form-input" value="${escAttr(reg.pending.label || suggestedKeyLabel(reg))}" maxlength="80">
          <div class="form-hint">Give yourself a label you’ll immediately recognize later.</div>
        </div>
      `;
      modalActions.innerHTML = `
        <button class="btn" id="review-back-btn">Back</button>
        <button class="btn btn-primary" id="save-key-btn">Save & Verify</button>
      `;
      document.getElementById('review-back-btn').addEventListener('click', () => {
        reg.step = reg.pending.mode === 'passphrase' ? 'passphrase' : 'choose';
        reg.pending = null;
        reg.localFingerprint = null;
        renderRegistrationModal();
      });
      document.getElementById('save-key-btn').addEventListener('click', saveRegisteredKey);
      return;
    }

    if (reg.step === 'saved') {
      subtitle.textContent = 'Your key is registered. You can finish now or add a recovery code while the key is still in memory.';
      const verification = reg.saved.verification;
      modalBody.innerHTML = `
        <div class="empty-state" style="padding:0; text-align:left;">
          <div style="display:flex; gap:0.35rem; flex-wrap:wrap; margin-bottom:0.75rem;">
            <span class="badge badge-info">Fingerprint verified</span>
            <span class="badge ${reg.saved.key.credential_verified ? 'badge-info' : 'badge-muted'}">${reg.saved.key.credential_verified ? 'Verified ceremony' : 'Unverified ceremony'}</span>
            ${reg.saved.key.recovery_enabled ? '<span class="badge badge-info">Recovery enabled</span>' : '<span class="badge badge-muted">Recovery not set</span>'}
          </div>
          <div class="modal-summary">
            <div class="modal-summary-row"><span class="k">Label</span><span class="v">${esc(reg.saved.key.label || 'Unnamed key')}</span></div>
            <div class="modal-summary-row"><span class="k">Fingerprint</span><span class="v" style="font-size:0.85rem;">${esc(reg.saved.key.key_fingerprint)}</span></div>
            <div class="modal-summary-row"><span class="k">Protection</span><span class="v">${esc(reg.saved.key.protection_tier)}</span></div>
            ${verification ? `<div class="modal-summary-row"><span class="k">Device posture</span><span class="v">${esc(verification.credential_device_type || 'unknown')}</span></div>` : ''}
          </div>
        </div>
      `;
      modalActions.innerHTML = `
        ${reg.saved.key.recovery_enabled ? '' : '<button class="btn" id="generate-recovery-btn">Generate Recovery Code</button>'}
        <button class="btn btn-primary" id="finish-registration-btn">Done</button>
      `;
      document.getElementById('finish-registration-btn').addEventListener('click', closeRegistrationModal);
      document.getElementById('generate-recovery-btn')?.addEventListener('click', generateRecoveryCode);
      return;
    }

    if (reg.step === 'recovery') {
      subtitle.textContent = 'This code is shown once. Write it down before you close this wizard.';
      modalBody.innerHTML = `
        <div class="form-group">
          <label class="form-label">Recovery code</label>
          <div class="card" style="font-family:var(--font-mono, monospace); font-size:1rem; line-height:1.7;">${esc(reg.recovery.mnemonic)}</div>
          <div class="form-hint">Store this somewhere separate from your device: safe, lockbox, or printed household records.</div>
        </div>
        <label class="flex gap-1" style="align-items:flex-start; cursor:pointer;">
          <input type="checkbox" id="recovery-confirmed">
          <span>I have written down this recovery code.</span>
        </label>
      `;
      modalActions.innerHTML = `
        <button class="btn" id="copy-recovery-btn">Copy Code</button>
        <button class="btn btn-primary" id="recovery-finish-btn" disabled>Finish</button>
      `;
      document.getElementById('copy-recovery-btn').addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(reg.recovery.mnemonic);
          toast('Recovery code copied', 'success');
        } catch {
          toast('Copy failed — please write it down manually', 'error');
        }
      });
      document.getElementById('recovery-confirmed').addEventListener('change', (event) => {
        document.getElementById('recovery-finish-btn').disabled = !event.target.checked;
      });
      document.getElementById('recovery-finish-btn').addEventListener('click', closeRegistrationModal);
    }
  }

  async function startWebAuthnRegistration(requestedMethod) {
    const reg = state.registration;
    if (!reg) return;
    if (!window.PublicKeyCredential || !navigator.credentials?.create) {
      toast('This browser does not support WebAuthn. Use the passphrase fallback instead.', 'error');
      return;
    }
    reg.method = requestedMethod;
    reg.step = 'working';
    reg.message = requestedMethod === 'security_key'
      ? 'Touch or insert your security key when your browser prompts you.'
      : 'Authenticate with this device when your browser prompts you.';
    renderRegistrationModal();

    try {
      const response = await fetch(`api/members/${reg.member.id}/keys/webauthn/options`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requested_method: requestedMethod }),
      });
      const payload = await response.json().catch(() => ({ error: response.statusText }));
      if (!response.ok) throw new Error(payload.error || response.statusText);

      const credential = await navigator.credentials.create({
        publicKey: toPublicKeyCreationOptions(payload.options),
      });
      if (!credential) throw new Error('WebAuthn ceremony was cancelled');

      const registrationPayload = await API.post(`api/members/${reg.member.id}/keys/webauthn/complete`, {
        registration_response: credentialToJSON(credential),
        client_authenticator_attachment: credential.authenticatorAttachment || null,
        transports: typeof credential.response?.getTransports === 'function'
          ? credential.response.getTransports()
          : [],
      });

      reg.message = 'Credential registered. One more touch confirms PRF support for encryption.';
      renderRegistrationModal();

      const assertionOptions = await API.post(`api/members/${reg.member.id}/keys/webauthn/assertion-options`, {
        credential_id: registrationPayload.verification.credential_id,
      });

      const assertion = await navigator.credentials.get({
        publicKey: PKICrypto.toPublicKeyRequestOptions(assertionOptions.options),
      });
      if (!assertion) throw new Error('WebAuthn assertion was cancelled');

      const assertionExtensionResults = assertion.getClientExtensionResults ? assertion.getClientExtensionResults() : {};
      const prfResult = assertionExtensionResults?.prf?.results?.first;
      if (!prfResult) {
        throw new Error('This credential did not expose the PRF extension during sign-in. Choose the passphrase fallback or try a different authenticator/browser.');
      }

      const keypair = await PKICrypto.generateMemberKeypair();
      let kek;
      try {
        kek = await PKICrypto.deriveKekFromPrf(prfResult);
      } catch (err) {
        throw err;
      }
      const wrappedPrivateKey = await PKICrypto.wrapPrivateKey(keypair.privateKey, kek);
      const localFingerprint = await PKICrypto.computeKeyFingerprint(keypair.publicKeyRaw);

      reg.pending = {
        mode: 'webauthn',
        requestedMethod,
        credentialId: registrationPayload.verification.credential_id,
        assertionResponse: credentialToJSON(assertion),
        publicKey: PKICrypto.toBase64(keypair.publicKeyRaw),
        encryptedPrivateKey: JSON.stringify({
          kind: 'webauthn_prf_v1',
          prf_salt_b64: assertionOptions.prf_salt,
          wrapped_private_key_b64: PKICrypto.toBase64(wrappedPrivateKey),
        }),
        privateKey: keypair.privateKey,
        label: '',
      };
      reg.localFingerprint = localFingerprint;
      reg.step = 'review';
      renderRegistrationModal();
    } catch (err) {
      reg.step = 'choose';
      reg.pending = null;
      reg.localFingerprint = null;
      renderRegistrationModal();
      toast(err.message || 'WebAuthn registration failed', 'error');
    }
  }

  async function preparePassphraseRegistration() {
    const reg = state.registration;
    if (!reg) return;
    const passphrase = document.getElementById('reg-passphrase').value;
    const confirm = document.getElementById('reg-passphrase-confirm').value;
    if (!passphrase || passphrase.length < 8) {
      toast('Use a passphrase with at least 8 characters', 'error');
      return;
    }
    if (passphrase !== confirm) {
      toast('Passphrases do not match', 'error');
      return;
    }

    reg.method = 'passphrase';
    reg.step = 'working';
    reg.message = 'Generating your keypair and wrapping it with your passphrase…';
    renderRegistrationModal();

    try {
      const keypair = await PKICrypto.generateMemberKeypair();
      const { kek, salt } = await PKICrypto.deriveKekFromPassphrase(passphrase);
      const wrappedPrivateKey = await PKICrypto.wrapPrivateKey(keypair.privateKey, kek);
      const localFingerprint = await PKICrypto.computeKeyFingerprint(keypair.publicKeyRaw);

      reg.pending = {
        mode: 'passphrase',
        publicKey: PKICrypto.toBase64(keypair.publicKeyRaw),
        encryptedPrivateKey: JSON.stringify({
          kind: 'passphrase_pbkdf2_v1',
          kdf: 'pbkdf2-sha256',
          iterations: 600000,
          salt_b64: PKICrypto.toBase64(salt),
          wrapped_private_key_b64: PKICrypto.toBase64(wrappedPrivateKey),
        }),
        privateKey: keypair.privateKey,
        label: '',
      };
      reg.passphrase = passphrase;
      reg.localFingerprint = localFingerprint;
      reg.step = 'review';
      renderRegistrationModal();
    } catch (err) {
      reg.step = 'passphrase';
      reg.pending = null;
      reg.localFingerprint = null;
      renderRegistrationModal();
      toast(err.message || 'Passphrase registration failed', 'error');
    }
  }

  async function saveRegisteredKey() {
    const reg = state.registration;
    if (!reg?.pending) return;
    const label = document.getElementById('reg-key-label').value.trim() || suggestedKeyLabel(reg);
    reg.pending.label = label;
    reg.step = 'working';
    reg.message = 'Saving your key and verifying the server fingerprint…';
    renderRegistrationModal();

    try {
      let savedPayload;
      if (reg.pending.mode === 'webauthn') {
        savedPayload = await API.post(`api/members/${reg.member.id}/keys/webauthn/finalize`, {
          assertion_response: reg.pending.assertionResponse,
          public_key: reg.pending.publicKey,
          encrypted_private_key: reg.pending.encryptedPrivateKey,
          label,
        });
      } else {
        const key = await API.post(`api/members/${reg.member.id}/keys`, {
          public_key: reg.pending.publicKey,
          encrypted_private_key: reg.pending.encryptedPrivateKey,
          algorithm: 'x25519',
          credential_id: null,
          prf_enabled: false,
          protection_tier: 'passphrase',
          label,
        });
        savedPayload = { key, verification: null };
      }

      if (savedPayload.key.key_fingerprint !== reg.localFingerprint) {
        throw new Error('Server fingerprint did not match the key generated in your browser');
      }

      reg.saved = savedPayload;
      reg.step = 'saved';
      await loadMembersAndKeys();
      if (state.me.role === 'parent') await loadAudit();
      renderRegistrationModal();
      toast('Encryption key registered and fingerprint verified', 'success');
    } catch (err) {
      reg.step = 'review';
      renderRegistrationModal();
      toast(err.message || 'Failed to save key', 'error');
    }
  }

  async function generateRecoveryCode() {
    const reg = state.registration;
    if (!reg?.pending?.privateKey || !reg.saved?.key?.id) {
      toast('Recovery generation is only available immediately after registration', 'error');
      return;
    }

    reg.step = 'working';
    reg.message = 'Generating a recovery code and saving its wrap…';
    renderRegistrationModal();

    try {
      const { mnemonic } = await PKICrypto.generateRecoveryMnemonic();
      const recoveryKek = await PKICrypto.deriveKekFromMnemonic(mnemonic);
      const wrappedPrivateKey = await PKICrypto.wrapPrivateKey(reg.pending.privateKey, recoveryKek);
      await API.post(`api/members/${reg.member.id}/keys/${reg.saved.key.id}/recovery`, {
        recovery_wrapped_private_key: JSON.stringify({
          kind: 'recovery_mnemonic_v1',
          wrapped_private_key_b64: PKICrypto.toBase64(wrappedPrivateKey),
        }),
        recovery_type: 'mnemonic_bip39',
      });
      reg.saved.key.recovery_enabled = true;
      reg.recovery = { mnemonic };
      reg.step = 'recovery';
      await loadMembersAndKeys();
      if (state.me.role === 'parent') await loadAudit();
      renderRegistrationModal();
      toast('Recovery code generated. Write it down before closing.', 'success');
    } catch (err) {
      reg.step = 'saved';
      renderRegistrationModal();
      toast(err.message || 'Failed to generate recovery code', 'error');
    }
  }

  function suggestedKeyLabel(reg) {
    if (!reg) return 'My key';
    if (reg.method === 'security_key') return 'Primary security key';
    if (reg.method === 'passkey') return 'This device passkey';
    return 'Passphrase backup key';
  }

  function bindPassphraseStrengthMeter() {
    const input = document.getElementById('reg-passphrase');
    const meter = document.getElementById('reg-passphrase-strength');
    const segments = meter.querySelectorAll('.strength-seg');
    const label = document.getElementById('reg-passphrase-strength-text');
    input.addEventListener('input', () => {
      const passphrase = input.value || '';
      if (!passphrase) {
        meter.style.display = 'none';
        return;
      }
      const { score, text } = scorePassphrase(passphrase);
      meter.style.display = 'block';
      const colors = ['var(--danger)', 'var(--warn)', '#f59e0b', 'var(--good)'];
      segments.forEach((segment, index) => {
        segment.style.background = index < score ? colors[Math.min(score - 1, colors.length - 1)] : 'var(--border)';
      });
      label.textContent = text;
    });
  }

  function scorePassphrase(passphrase) {
    const common = new Set(['password', 'letmein', 'qwerty', 'abc12345', 'monkey123', 'dragon12', 'master12', 'passw0rd']);
    if (common.has(passphrase.toLowerCase())) return { score: 1, text: 'Common passphrase — easily guessed' };
    let score = 0;
    if (passphrase.length >= 8) score++;
    if (passphrase.length >= 12) score++;
    if (/[A-Z]/.test(passphrase) && /[a-z]/.test(passphrase)) score++;
    if (/\d/.test(passphrase) && /[^A-Za-z0-9]/.test(passphrase)) score++;
    if (score <= 1) return { score: 1, text: 'Weak — try a longer, more varied passphrase' };
    if (score === 2) return { score: 2, text: 'Fair — acceptable for low-sensitivity recovery' };
    if (score === 3) return { score: 3, text: 'Strong — good everyday protection' };
    return { score: 4, text: 'Excellent — high confidence passphrase' };
  }

  function toPublicKeyCreationOptions(optionsJSON) {
    const options = JSON.parse(JSON.stringify(optionsJSON));
    options.challenge = PKICrypto.base64urlToBuffer(options.challenge);
    options.user.id = PKICrypto.base64urlToBuffer(options.user.id);
    options.excludeCredentials = (options.excludeCredentials || []).map((credential) => ({
      ...credential,
      id: PKICrypto.base64urlToBuffer(credential.id),
    }));
    if (options.extensions?.prf?.eval?.first) {
      options.extensions = {
        ...options.extensions,
        prf: {
          ...options.extensions.prf,
          eval: {
            ...options.extensions.prf.eval,
            first: PKICrypto.base64urlToBuffer(options.extensions.prf.eval.first),
          },
        },
      };
    }
    return options;
  }

  function credentialToJSON(credential) {
    const response = {
      clientDataJSON: bufferToBase64url(credential.response.clientDataJSON),
    };
    if ('attestationObject' in credential.response) {
      response.attestationObject = bufferToBase64url(credential.response.attestationObject);
      response.transports = typeof credential.response.getTransports === 'function'
        ? credential.response.getTransports()
        : [];
    }
    if ('authenticatorData' in credential.response) {
      response.authenticatorData = bufferToBase64url(credential.response.authenticatorData);
      response.signature = bufferToBase64url(credential.response.signature);
      response.userHandle = credential.response.userHandle
        ? bufferToBase64url(credential.response.userHandle)
        : null;
    }
    return {
      id: credential.id,
      rawId: bufferToBase64url(credential.rawId),
      type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment || null,
      clientExtensionResults: normalizeExtensionResults(credential.getClientExtensionResults ? credential.getClientExtensionResults() : {}),
      response,
    };
  }

  function normalizeExtensionResults(results) {
    const normalized = {};
    if (results?.prf) {
      normalized.prf = {};
      if (typeof results.prf.enabled === 'boolean') normalized.prf.enabled = results.prf.enabled;
      if (results.prf.results?.first) normalized.prf.results = { first: bufferToBase64url(results.prf.results.first) };
    }
    return normalized;
  }

  function bufferToBase64url(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  async function loadAudit() {
    const logs = await API.get('api/audit?limit=30');
    auditTbody.innerHTML = logs.map((log) => `
      <tr>
        <td class="text-sm text-dim">${new Date(log.created_at).toLocaleString()}</td>
        <td>${log.actor_avatar || ''} ${esc(log.actor_name || 'System')}</td>
        <td>${esc(log.action)}</td>
        <td class="text-sm text-dim">${log.entity_type ? `${esc(log.entity_type)} #${log.entity_id}` : ''}</td>
      </tr>
    `).join('') || '<tr><td colspan="4" class="text-dim text-center">No activity yet</td></tr>';
  }

  function hideAuditSection() {
    const table = document.getElementById('audit-table');
    if (table) {
      table.innerHTML = '<tbody><tr><td class="text-dim text-sm">Recent activity is available to parent accounts.</td></tr></tbody>';
    }
  }

  function closeModal(id) {
    if (id === 'key-registration-modal') {
      closeRegistrationModal();
      return;
    }
    if (id === 'passphrase-modal') {
      state.passphraseMember = null;
    }
    document.getElementById(id)?.classList.add('hidden');
  }

  function truncateFingerprint(value = '') {
    const parts = String(value).split(':');
    if (parts.length <= 4) return value;
    return `${parts.slice(0, 4).join(':')}…${parts.slice(-2).join(':')}`;
  }

  function esc(value) {
    const div = document.createElement('div');
    div.textContent = value ?? '';
    return div.innerHTML;
  }

  function escAttr(value) {
    return esc(value).replace(/"/g, '&quot;');
  }

  function toast(message, type = 'success') {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    document.getElementById('toasts').appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  function showConfirm(title, message) {
    return new Promise((resolve) => {
      document.getElementById('confirm-title').textContent = title;
      document.getElementById('confirm-message').textContent = message;
      const modal = document.getElementById('confirm-modal');
      const okBtn = document.getElementById('confirm-ok-btn');
      const cancelBtn = document.getElementById('confirm-cancel-btn');
      modal.classList.remove('hidden');
      function cleanup(result) {
        modal.classList.add('hidden');
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        resolve(result);
      }
      function onOk() { cleanup(true); }
      function onCancel() { cleanup(false); }
      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
    });
  }

  init();
})();
