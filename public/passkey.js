'use strict';

// Passkey checks in tailnet mode (wire contract, section 8). Home Base serves its step-up helper on this hostname at
// /_sovereign/auth/stepup.js: it asks for a tap, runs the passkey check with Home Base, and sets the cookie Home Source
// reads. In local mode nothing asks for a check, so the helper loads only when an answer asks for one. This is not
// Home Source's own document keys (settings and document pages unlock those): it only says who is asking.
(function sourcePasskey() {
  const HELPER = '/_sovereign/auth/stepup.js';
  const UNAVAILABLE = 'Home Source couldn\'t reach Home Base for a passkey check. Try again in a minute.';
  const CANCELLED = 'This needs a check with your passkey first.';
  const NOT_ACCEPTED = 'Your passkey check didn\'t go through. Try again.';
  const STILL_REFUSED = 'Your passkey check went through, but Home Source couldn\'t confirm it yet. Try again in a minute.';
  const OPENING = 'Checked. Opening it now…';
  const RELOADED = 'source-passkey-reloaded';
  let helper = null;

  function loadHelper() {
    if (window.SovereignStepUp) return Promise.resolve(window.SovereignStepUp);
    if (!helper) {
      helper = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = HELPER;
        const failed = () => { helper = null; script.remove(); reject(new Error(UNAVAILABLE)); };
        script.onload = () => (window.SovereignStepUp ? resolve(window.SovereignStepUp) : failed());
        script.onerror = failed;
        document.head.append(script);
      });
    }
    return helper;
  }

  // One check at a time: requests sent together (a page loading its lists in parallel) share it, since one check sets
  // the cookie each of them reads. A request whose answer comes back after a check has ended takes the outcome of the
  // first check that ended after it was sent: the one its batch shared. So a late answer neither asks again after a
  // cancel nor saves part of what the member cancelled, even once a later save has been checked. A request notes how
  // many checks had ended when it was sent; the next one to end is the one it waits on.
  let checking = null;
  const ended = [];   // the outcome of every check that ended, in order: null (through), false (cancelled), or an error
  const settle = (outcome) => { ended.push(outcome); };
  function satisfyOnce(stepUp, endedBeforeSend) {
    if (ended.length > endedBeforeSend) {
      const outcome = ended[endedBeforeSend];
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
    }
    if (!checking) {
      checking = loadHelper().then((h) => h.satisfy(stepUp)).then(
        (done) => { settle(done === false ? false : null); return done; },
        (err) => { settle(err); throw err; },
      ).finally(() => { checking = null; });
    }
    return checking;
  }

  async function stepUpAsked(res) {
    if (res.status !== 401) return null;
    const body = await res.clone().json().catch(() => null);
    return body && body.error === 'step_up_required' ? body : null;
  }

  // fetch, and when the answer asks for a passkey check: the check, then the same request once more. The body must be
  // a string, a FormData or absent, so the retry sends exactly what was asked.
  async function passkeyFetch(url, init = {}) {
    const endedBeforeSend = ended.length;
    const first = await fetch(url, init);
    const stepUp = await stepUpAsked(first);
    if (!stepUp) return first;
    if ((await satisfyOnce(stepUp, endedBeforeSend)) === false) throw new Error(CANCELLED);
    const retry = await fetch(url, init);
    if (await stepUpAsked(retry)) throw new Error(NOT_ACCEPTED);
    return retry;
  }

  // The page Home Source answers with when a parent opens it, or a download, without a current check: run the check,
  // then reload. A download leaves this page showing, so it says the check went through. If this page comes back
  // straight after a check that went through (Home Base's new key or a changed access hasn't reached Home Source yet),
  // it waits for a tap rather than looping through checks.
  function checkOnOpen(main) {
    const status = document.getElementById('passkey-status');
    const retry = document.getElementById('passkey-retry');
    let stepUp;
    try { stepUp = JSON.parse(main.dataset.stepUp); } catch { stepUp = null; }
    async function run() {
      retry.hidden = true;
      status.textContent = '';
      try {
        if (!stepUp) throw new Error(NOT_ACCEPTED);
        if ((await (await loadHelper()).satisfy({ ...stepUp, message: 'Check with your passkey to open Home Source.' })) !== false) {
          try { sessionStorage.setItem(RELOADED, String(Date.now())); } catch { /* private mode: no loop guard to keep */ }
          status.textContent = OPENING;
          window.location.reload();
          return;
        }
        status.textContent = CANCELLED;
      } catch (err) {
        status.textContent = err.message || NOT_ACCEPTED;
      }
      retry.hidden = false;
    }
    retry.addEventListener('click', run);
    let reloadedAt = 0;
    try { reloadedAt = Number(sessionStorage.getItem(RELOADED)) || 0; sessionStorage.removeItem(RELOADED); } catch { /* as above */ }
    if (Date.now() - reloadedAt < 60 * 1000) {
      status.textContent = STILL_REFUSED;
      retry.hidden = false;
      return;
    }
    run();
  }

  window.SourcePasskey = { fetch: passkeyFetch };
  const main = document.getElementById('passkey-check');
  if (main) checkOnOpen(main);
})();
