'use strict';

// In tailnet mode (Home Base suite identity) a parent's request can need a passkey check first: the answer is 401
// step_up_required. passkey.js, loaded the first time that happens, runs the check and sends the request once more.
// In local mode nothing asks, so it never loads.
let passkeyLoading = null;
function loadPasskey() {
  if (window.SourcePasskey) return Promise.resolve(window.SourcePasskey);
  if (!passkeyLoading) {
    passkeyLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'passkey.js';
      const failed = () => { passkeyLoading = null; script.remove(); reject(new Error('Home Source couldn\'t start a passkey check. Try again in a minute.')); };
      script.onload = () => (window.SourcePasskey ? resolve(window.SourcePasskey) : failed());
      script.onerror = failed;
      document.head.append(script);
    });
  }
  return passkeyLoading;
}

async function send(path, init) {
  if (!window.SourcePasskey) {
    const res = await fetch(path, init);
    if (res.status !== 401) return res;
    const body = await res.clone().json().catch(() => null);
    if (body?.error !== 'step_up_required') return res;
    await loadPasskey();
  }
  return window.SourcePasskey.fetch(path, init);
}

window.API = {
  fetch: send,

  async get(path) {
    const res = await send(path);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  },

  async post(path, body) {
    const res = await send(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  },

  async put(path, body) {
    const res = await send(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  },

  async del(path) {
    // Every write says it is JSON, even with no body: in tailnet mode a write without it is refused.
    const res = await send(path, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  },

  async upload(path, file, metadata = {}) {
    const form = new FormData();
    form.append('file', file);
    form.append('metadata', JSON.stringify(metadata));

    let res;
    try {
      res = await send(path, { method: 'POST', body: form });
    } catch (e) {
      throw new Error('Upload failed — check your connection and try again');
    }
    if (!res.ok) {
      if (res.status === 413) throw new Error('File too large — server rejected the upload (check nginx client_max_body_size)');
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  },

  async uploadFields(path, fields = {}) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && value !== null) form.append(key, value);
    }
    let res;
    try {
      res = await send(path, { method: 'POST', body: form });
    } catch (e) {
      throw new Error('Upload failed — check your connection and try again');
    }
    if (!res.ok) {
      if (res.status === 413) throw new Error('File too large — server rejected the upload (check nginx client_max_body_size)');
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  },

  async uploadScanPages(path, pages = [], metadata = {}) {
    const form = new FormData();
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const file = page instanceof File ? page : new File([page], `scan-page-${i + 1}.jpg`, { type: 'image/jpeg' });
      form.append('scan_pages', file);
    }
    form.append('metadata', JSON.stringify(metadata || {}));
    let res;
    try {
      res = await send(path, { method: 'POST', body: form });
    } catch {
      throw new Error('Upload failed — check your connection and try again');
    }
    if (!res.ok) {
      if (res.status === 413) throw new Error('Scan upload too large — server rejected the upload');
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  }
};
