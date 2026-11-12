'use strict';

// Suite identity (Home Base Feature-10). SOVEREIGN_AUTH_MODE picks how Home Source knows who is asking: 'local' is
// its own passphrases and sessions, 'tailnet' the household member nginx names. Home Base writes the mode when it
// switches the app over; an install from before that has none, which means local.
//
// In tailnet mode this runs before anything else reads the request: a write is checked before any body parser, and
// every request but Home Base's probes, the page assets and the token pages for people outside the household needs a
// household member, linked by a parent to one of Home Source's own members. The role on the family_members row never
// decides what someone may do. Home Source's own document keys (lib/pki.js, lib/webauthn.js) are a separate thing:
// they decrypt documents, and nothing here touches them.
const { createIdentity, createRequestGuard, createSnapshotReader, guardExpress } = require('sovereign-auth');

const APP_ID = 'home-source';

// SOVEREIGN_HOMEBASE_UID: the owner Home Base gives its directory snapshot. Never root.
function homeBaseUid(value) {
  const text = String(value ?? '').trim();
  const uid = /^[1-9][0-9]{0,9}$/.test(text) ? Number(text) : NaN;
  if (!(uid < 4294967295)) throw new Error(`SOVEREIGN_HOMEBASE_UID must be the Home Base user's uid, not '${text}'`);
  return uid;
}

// The origin every write must come from in tailnet mode: the address Home Base publishes the app at.
function publicOrigin(value) {
  let url;
  try { url = new URL(String(value ?? '')); } catch { url = null; }
  if (!url || url.protocol !== 'https:') throw new Error(`tailnet mode needs APP_PUBLIC_URL, the app's https address, not '${value ?? ''}'`);
  return url.origin;
}

// Where the app's pages live under that address (/source/). Plain path segments only, so a redirect built on it stays
// on this host: '//elsewhere/' would send the browser off it.
function publicPath(value) {
  const { pathname } = new URL(String(value));
  if (!/^\/(?:[A-Za-z0-9._~-]+\/)*(?:[A-Za-z0-9._~-]+)?$/.test(pathname)) {
    throw new Error(`APP_PUBLIC_URL must have a plain path such as /source/, not '${pathname}'`);
  }
  return pathname.replace(/\/?$/, '/');
}

const ID = '[1-9][0-9]{0,18}';
const TOKEN = '[A-Za-z0-9_-]{1,256}';

// Requests that need no member: Home Base's health and readiness probes, which come over the socket with no identity
// headers and no fetch metadata, and the page assets (never data).
const OPEN_PATHS = new Set(['/api/health', '/api/ready']);
const ASSET_PATH = /^\/[\w.-]+\.(?:css|js|svg|ico|png|woff2?)$/;

// People outside the household reach these by a token in a link from an email or a message, with no sign-in: a share
// link, a trustee's invitation, a trustee's pause, a contact address to confirm, the owner's check-in, and a
// recipient's delivery. They stay reachable by the token alone; the token decides what they reveal and change, exactly
// as in local mode, and the request guard still applies (a write is JSON from this origin). Exact spellings and
// methods only: any other one needs a member as usual.
const OUTSIDER_PAGES = new Set([
  '/share.html', '/trustee-invite.html',
  '/trustee-action', '/trustee-action.html', '/trustee-contact', '/trustee-contact.html',
  '/continuity-contact', '/continuity-contact.html', '/check-in', '/check-in.html',
  '/recipient-delivery', '/recipient-delivery.html',
]);
const SHARE_PAGE = new RegExp(`^/share/${TOKEN}$`);
const OUTSIDER_API = [
  ['GET', new RegExp(`^/api/share/${TOKEN}$`)],
  ['POST', new RegExp(`^/api/share/${TOKEN}/verify$`)],
  ['GET', new RegExp(`^/api/share/${TOKEN}/files/${ID}/download$`)],
  ['GET', new RegExp(`^/api/trustee-invitations/${TOKEN}$`)],
  ['POST', new RegExp(`^/api/trustee-invitations/${TOKEN}/(?:register|webauthn/(?:options|complete|assertion-options|finalize))$`)],
  ['POST', /^\/api\/continuity\/check-in(?:\/validate)?$/],
  ['POST', /^\/api\/continuity\/trustee-action\/(?:validate|pause)$/],
  ['POST', /^\/api\/continuity\/(?:contact-verification|trustee-contact-verification)\/(?:validate|confirm)$/],
  ['POST', /^\/api\/continuity\/recipient\/(?:exchange|reissue)$/],
  ['GET', /^\/api\/continuity\/recipient\/manifest$/],
  ['GET', new RegExp(`^/api/continuity/recipient/items/${ID}(?:/ciphertext)?$`)],
  ['POST', new RegExp(`^/api/continuity/recipient/items/${ID}/webauthn/assertion-options$`)],
];
function isOutsiderRoute(req) {
  if (['GET', 'HEAD'].includes(req.method) && (OUTSIDER_PAGES.has(req.path) || SHARE_PAGE.test(req.path))) return true;
  return OUTSIDER_API.some(([method, route]) => method === req.method && route.test(req.path));
}

// The routes that take uploads (the ones that parse multipart). Everywhere else a write is JSON only, which keeps
// forms out.
const UPLOAD_ROUTE = new RegExp(`^/api/(?:documents(?:/scan-multi|/${ID}/(?:encrypt|files))?|import/batches/${ID}/items)$`);

// What a parent nobody has linked yet may use: the link page, and setup while Home Source has no household (setup
// refuses once one exists). Anything else sends them to the link page.
const UNLINKED_PARENT_PATHS = new Set(['/link', '/api/suite/links', '/setup', '/setup.html', '/api/bootstrap', '/api/bootstrap/household']);
const LINK_ROUTE = new RegExp(`^/api/suite/links/${ID}$`);

// The API routes a page opens directly, by a link, an iframe or a download, rather than fetching: a document's file,
// a backup, and a shared file. Everything else under /api/ is for the app's own pages: a sibling hostname can navigate
// here with the member's identity (D20), and some GETs record what they show.
const NAVIGABLE_API = [
  new RegExp(`^/api/documents/${ID}/files/${ID}/download$`),
  /^\/api\/backup\/download\/[^/]+$/,
  new RegExp(`^/api/share/${TOKEN}/files/${ID}/download$`),
];

// Express matches routes in any case and with a trailing slash. A check that refuses something has to see every
// spelling that reaches the route. The allowlists above stay exact on purpose: a spelling they don't know is refused.
const isApiPath = (path) => /^\/api(?:\/|$)/i.test(path);
const routeSpelling = (path) => path.toLowerCase().replace(/\/+$/, '');

// Kids have no passkey (D7), so what they reach is listed here and everything else is refused: reading their own
// documents and the ones shared with them, and unlocking the ones encrypted to their own key. Each of these scopes its
// answer to req.member on the server, sealed designations included (requireDocumentAuthorization, the kid branch of
// the list, and the self-only checks on a member's keys). Not here, because their answers aren't scoped that tightly:
// the member list, the tag list, a document's share links, thumbnails by file name, and search, the dashboard's
// counts and key posture (they count documents a sealed designation hides, and the dashboard shows the household's
// latest backup). Nor is any change: uploading, editing, or enrolling, recovering, testing and revoking a key.
const KID_API_ROUTES = [
  ['GET', /^\/api\/auth\/me$/],
  ['GET', /^\/api\/documents$/],
  ['GET', new RegExp(`^/api/documents/${ID}(?:/key-info|/magicindex-status|/links)?$`)],
  ['GET', new RegExp(`^/api/documents/${ID}/files/${ID}/download$`)],
  ['GET', new RegExp(`^/api/members/${ID}/keys$`)],
  ['GET', new RegExp(`^/api/members/${ID}/keys/${ID}/material$`)],
  ['POST', new RegExp(`^/api/members/${ID}/keys/webauthn/assertion-options$`)],
];
// The pages a kid's navigation offers, and a document's own page. Any other page sends them to the dashboard.
const KID_PAGES = new Set(['/', '/index.html', '/documents.html', '/document.html', '/search.html', '/settings.html']);

// Local sign-in has no meaning in tailnet mode, and its saved passphrases and sessions wait untouched for a return to
// local mode: signing out would delete a session, so it is refused too.
const LOCAL_AUTH_ROUTES = new Set(['POST /api/auth/login', 'POST /api/auth/passphrase', 'POST /api/auth/logout']);

const REFUSALS = {
  directory: {
    status: 503,
    title: 'Home Source can\'t check who you are right now',
    text: 'It couldn\'t read the household directory from Home Base. Try again in a minute, and if this keeps happening, tell whoever runs Home Base.',
  },
  not_member: {
    status: 403,
    title: 'Home Source doesn\'t know you yet',
    text: 'Ask whoever runs Home Base to give you access to Home Source.',
  },
  not_linked: {
    status: 403,
    title: 'Almost there',
    text: 'Your household account isn\'t linked to anyone in Home Source yet. Ask a parent to link you.',
  },
  stale_link: {
    status: 403,
    title: 'Almost there',
    text: 'Your household account is now a kid\'s, but it\'s still linked to a parent in Home Source. Ask a parent to link you again.',
  },
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function askPage({ title, text }, name) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Home Source</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; box-sizing: border-box;
    font: 16px/1.5 system-ui, -apple-system, sans-serif; background: #f7f5f2; color: #1c1917; }
  main { max-width: 28rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .5rem; }
  p { margin: 0; color: #57534e; }
  @media (prefers-color-scheme: dark) { body { background: #0b0b0b; color: #e7e5e4; } p { color: #a8a29e; } }
</style>
</head>
<body><main><h1>${escapeHtml(name ? `${title}, ${name}` : title)}</h1><p>${escapeHtml(text)}</p></main></body>
</html>
`;
}

function refuse(req, res, code, member) {
  const refusal = REFUSALS[code];
  res.status(refusal.status).set('Cache-Control', 'no-store');
  if (isApiPath(req.path)) return res.json({ error: refusal.title, code });
  return res.type('html').send(askPage(refusal, member?.name));
}

// createSuiteIdentity(env) checks the configuration once, at startup: an unknown mode, or tailnet mode off the app's
// socket or without Home Base's uid and the public address, refuses to start. findLinked(memberId) returns the
// family_members row a parent linked to that directory member, or null.
function createSuiteIdentity(env = process.env, { reader, findLinked } = {}) {
  const mode = env.SOVEREIGN_AUTH_MODE === undefined ? 'local' : env.SOVEREIGN_AUTH_MODE;
  const tailnet = String(mode).trim() === 'tailnet';
  const snapshotReader = tailnet ? reader || createSnapshotReader({ homeBaseUid: homeBaseUid(env.SOVEREIGN_HOMEBASE_UID) }) : null;
  const identity = createIdentity({ appId: APP_ID, mode, listen: env.SOVEREIGN_LISTEN, reader: snapshotReader });
  if (tailnet && typeof findLinked !== 'function') throw new Error('tailnet mode needs a way to find linked members');
  const passThrough = (_req, _res, next) => next();
  if (!tailnet) return { mode: identity.mode, tailnet: false, identity, guard: passThrough, requireMember: passThrough, directory: () => null };

  // A sensitive app's own hostname: resource isolation and the write check (wire contract, section 4). Both read only
  // the method and headers, so they run before anything reads the body.
  const origin = publicOrigin(env.APP_PUBLIC_URL);
  const basePath = publicPath(env.APP_PUBLIC_URL);
  const writes = guardExpress(createRequestGuard({ origin }), { mode: 'enforce' });
  const uploads = guardExpress(createRequestGuard({ origin, contentTypes: ['application/json', 'multipart/form-data'] }), { mode: 'enforce' });
  function guard(req, res, next) {
    if (OPEN_PATHS.has(req.path)) return next();
    return (UPLOAD_ROUTE.test(req.path) ? uploads : writes)(req, res, next);
  }

  // The household members with access to Home Source, as the directory says now, or null without a snapshot.
  function directory() {
    const state = snapshotReader.current();
    if (!state?.ok) return null;
    return state.snapshot.members
      .filter((member) => member.status === 'active' && member.apps.includes(APP_ID) && member.login !== 'tagged-devices')
      .map(({ memberId, name, role }) => ({ memberId, name, role }));
  }

  function kidMayUse(req) {
    if (isApiPath(req.path)) return KID_API_ROUTES.some(([method, route]) => method === req.method && route.test(req.path));
    return ['GET', 'HEAD'].includes(req.method) && KID_PAGES.has(req.path);
  }

  async function requireMember(req, res, next) {
    const isRead = ['GET', 'HEAD'].includes(req.method);
    if (OPEN_PATHS.has(req.path) || (isRead && ASSET_PATH.test(req.path))) return next();
    const isApi = isApiPath(req.path);
    if (isApi && req.headers['sec-fetch-mode'] === 'navigate' && !NAVIGABLE_API.some((route) => route.test(req.path))) {
      return res.status(403).set('Cache-Control', 'no-store').json({ error: 'This address is only for Home Source\'s own pages.', code: 'not_a_page' });
    }
    if (isOutsiderRoute(req)) return next();
    const { member, reason } = identity.identify(req.headers);
    if (!member) return refuse(req, res, reason === 'no_snapshot' ? 'directory' : 'not_member');
    let row;
    try {
      row = await findLinked(member.memberId);
    } catch (err) {
      return next(err);
    }
    const isParent = member.role === 'parent';
    if (!row && !isParent) return refuse(req, res, 'not_linked', member);
    // A kid's pages show the data of the member they are linked to, so a kid's account opens only a kid's row. The
    // directory can change a role at any time after the link was made, so this is checked on every request.
    if (row && !isParent && row.role !== 'kid') return refuse(req, res, 'stale_link', member);
    if (!row && !UNLINKED_PARENT_PATHS.has(req.path) && !LINK_ROUTE.test(req.path)) {
      if (req.method === 'GET' && !isApi) return res.redirect(303, `${basePath}link`);
      return refuse(req, res, 'not_linked', member);
    }
    if (LOCAL_AUTH_ROUTES.has(`${req.method} ${routeSpelling(req.path)}`)) {
      return res.status(409).set('Cache-Control', 'no-store').json({ error: 'Home Source signs in through your household account here.', code: 'tailnet_mode' });
    }
    if (!isParent && !kidMayUse(req)) {
      if (isApi || !isRead) return res.status(403).set('Cache-Control', 'no-store').json({ error: 'Parent access required', code: 'parent_only' });
      return res.redirect(303, basePath);
    }
    if (['/login', '/login.html'].includes(routeSpelling(req.path))) return res.redirect(303, basePath);
    req.suiteMember = member;
    // Everything after this sees the linked member as in local mode, with the directory's role, never the row's.
    if (row) req.member = { id: row.id, name: row.name, role: isParent ? 'parent' : 'kid', avatar_emoji: row.avatar_emoji };
    return next();
  }

  return { mode: identity.mode, tailnet: true, identity, guard, requireMember, directory };
}

module.exports = { APP_ID, createSuiteIdentity, homeBaseUid, publicOrigin, publicPath };
