'use strict';

const path = require('path');
const { Router } = require('express');
const { pool } = require('./db');
const audit = require('./audit');

const MAX_ID = 2147483647;

// A parent, as Home Base's directory says now, links each Home Source member to the household member they are. The
// directory's role is checked on every request; the role on the row never grants this. getSuite returns the current
// suite identity (lib/suite-identity.js).
function createSuiteLinks(getSuite) {
  const router = Router();

  function requireSuiteParent(req, res, next) {
    if (!getSuite().tailnet) return res.status(404).json({ error: 'Not found' });
    if (req.suiteMember?.role !== 'parent') {
      return res.status(403).json({ error: 'Only a parent can link household members', code: 'parent_required' });
    }
    return next();
  }

  router.get('/link', requireSuiteParent, (_req, res) => {
    res.set('Cache-Control', 'no-store').sendFile(path.join(__dirname, '..', 'public', 'link.html'));
  });

  router.get('/api/suite/links', requireSuiteParent, async (req, res) => {
    try {
      const directory = getSuite().directory();
      if (!directory) return res.status(503).json({ error: 'The household directory is unavailable', code: 'directory' });
      const { rows } = await pool.query('SELECT id, name, role, avatar_emoji, suite_member_id FROM family_members ORDER BY id');
      return res.set('Cache-Control', 'no-store').json({ you: req.suiteMember.memberId, directory, members: rows });
    } catch (err) {
      console.error('Could not load member links:', err.message);
      return res.status(500).json({ error: 'Could not load household members' });
    }
  });

  router.put('/api/suite/links/:id', requireSuiteParent, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id > MAX_ID) return res.status(404).json({ error: 'No such Home Source member', code: 'not_found' });
      const wanted = req.body?.suite_member_id;
      let account = null;
      if (wanted !== null) {
        const directory = getSuite().directory();
        if (!directory) return res.status(503).json({ error: 'The household directory is unavailable', code: 'directory' });
        account = typeof wanted === 'string' ? directory.find((member) => member.memberId === wanted) : null;
        if (!account) return res.status(400).json({ error: 'Pick a household member who has access to Home Source', code: 'unknown_member' });
      }
      // A kid's pages show the documents of the member they are linked to, so a kid's account never takes a parent's
      // place.
      const { rows } = await pool.query(
        `UPDATE family_members SET suite_member_id = $1
         WHERE id = $2 AND ($3::boolean OR role <> 'parent')
         RETURNING id, name, role, avatar_emoji, suite_member_id`,
        [wanted, id, wanted === null || account.role === 'parent']
      );
      if (!rows.length) {
        const { rows: found } = await pool.query('SELECT 1 FROM family_members WHERE id = $1', [id]);
        if (found.length) return res.status(400).json({ error: 'A kid\'s account can\'t be linked to a parent in Home Source', code: 'role_mismatch' });
        return res.status(404).json({ error: 'No such Home Source member', code: 'not_found' });
      }
      // Who made the change, by their household member ID, never a name.
      await audit.log('suite.link_changed', 'family_member', id, null, { by: req.suiteMember.memberId, linked: wanted !== null });
      return res.json(rows[0]);
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'That household member is already linked to someone else', code: 'already_linked' });
      }
      console.error('Could not save member link:', err.message);
      return res.status(500).json({ error: 'Could not save the link' });
    }
  });

  return router;
}

module.exports = { createSuiteLinks };
