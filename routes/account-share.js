const express = require('express');
const {
  createAccountShareCode, getActiveAccountShareCode, revokeAccountShareCode,
  redeemAccountShareCode, listAccountViewers, revokeAccountViewer, insertMessage
} = require('../db');
const { requireAuth, blockIfSuspended } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/account-share/code — the current active code for "Share my
// documents", if one exists. My Account calls this first so it can reuse
// one QR instead of minting a fresh code on every page load.
router.get('/code', async (req, res) => {
  try {
    const share = await getActiveAccountShareCode(req.user.id);
    res.json({ code: share ? share.code : null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load your share code' });
  }
});

// POST /api/account-share/code — mint a fresh code, replacing any active
// one (so an old QR someone still has stops working once you regenerate).
router.post('/code', blockIfSuspended, async (req, res) => {
  try {
    const existing = await getActiveAccountShareCode(req.user.id);
    if (existing) await revokeAccountShareCode(existing.id, req.user.id);
    const share = await createAccountShareCode(req.user.id, null);
    res.status(201).json({ code: share.code });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Could not create a share code' });
  }
});

// DELETE /api/account-share/code — turn off the current code so it can no
// longer be scanned/redeemed. Anyone who already redeemed it keeps access
// until you also revoke them individually below.
router.delete('/code', blockIfSuspended, async (req, res) => {
  try {
    const existing = await getActiveAccountShareCode(req.user.id);
    if (existing) await revokeAccountShareCode(existing.id, req.user.id);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not revoke your share code' });
  }
});

// POST /api/account-share/redeem  { code } — scan/type someone else's
// account-share code to gain standing access to every file they own.
router.post('/redeem', blockIfSuspended, async (req, res) => {
  const code = (req.body && req.body.code ? String(req.body.code) : '').trim();
  if (!code) return res.status(400).json({ error: 'Enter or scan a code first.' });
  try {
    const result = await redeemAccountShareCode(code, req.user.id);
    if (!result.alreadyHadAccess) {
      insertMessage({
        recipientId: result.ownerId, senderId: req.user.id,
        body: `${req.user.email} scanned your document-sharing code and can now see everything in your files.`
      }).catch(() => {});
    }
    res.json({ ok: true, ownerName: result.ownerName });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Could not redeem that code' });
  }
});

// GET /api/account-share/viewers — everyone currently able to see all of
// my documents, for the list + Revoke buttons on My Account.
router.get('/viewers', async (req, res) => {
  try {
    res.json({ viewers: await listAccountViewers(req.user.id) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load who has access' });
  }
});

// DELETE /api/account-share/viewers/:viewerId — pull back access already
// granted to one specific person.
router.delete('/viewers/:viewerId', blockIfSuspended, async (req, res) => {
  try {
    await revokeAccountViewer(req.user.id, Number(req.params.viewerId));
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not revoke access' });
  }
});

module.exports = router;
