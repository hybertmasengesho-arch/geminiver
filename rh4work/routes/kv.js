const express = require('express');
const { kvGet, kvSet, kvDelete, kvList } = require('../db');
const { requireAuth, blockIfSuspended } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function scopeFor(req, sharedParam) {
  const shared = sharedParam === true || sharedParam === 'true';
  return shared ? 0 : req.user.id;
}

router.get('/', async (req, res) => {
  const { app, key } = req.query;
  if (!app || !key) return res.status(400).json({ error: 'app and key are required' });
  const scope = scopeFor(req, req.query.shared);
  try {
    const value = await kvGet(scope, app, key);
    res.json({ key, value });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not read value' });
  }
});

// Reading is always allowed, even for suspended accounts — only writes are blocked.
router.post('/', blockIfSuspended, async (req, res) => {
  const { app, key, value, shared } = req.body || {};
  if (!app || !key || value === undefined) return res.status(400).json({ error: 'app, key, and value are required' });
  const scope = scopeFor(req, shared);
  const valueStr = typeof value === 'string' ? value : JSON.stringify(value);
  try {
    await kvSet(scope, app, key, valueStr);
    res.json({ key, value: valueStr, shared: !!shared });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not save value' });
  }
});

router.delete('/', blockIfSuspended, async (req, res) => {
  const { app, key, shared } = req.body || {};
  if (!app || !key) return res.status(400).json({ error: 'app and key are required' });
  const scope = scopeFor(req, shared);
  try {
    await kvDelete(scope, app, key);
    res.json({ key, deleted: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not delete value' });
  }
});

router.get('/list', async (req, res) => {
  const { app } = req.query;
  const prefix = req.query.prefix || '';
  if (!app) return res.status(400).json({ error: 'app is required' });
  const scope = scopeFor(req, req.query.shared);
  try {
    const keys = await kvList(scope, app, prefix);
    res.json({ keys });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not list keys' });
  }
});

module.exports = router;
