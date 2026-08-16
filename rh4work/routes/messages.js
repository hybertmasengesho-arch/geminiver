const express = require('express');
const { listUnreadMessagesForUser, markMessageRead } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/messages/unread — polled by nav.js on every page load to show
// any admin message as a popup toast.
router.get('/unread', async (req, res) => {
  try {
    res.json({ messages: await listUnreadMessagesForUser(req.user.id) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load messages' });
  }
});

// POST /api/messages/:id/read — called when the user dismisses a toast.
router.post('/:id/read', async (req, res) => {
  try {
    await markMessageRead(req.params.id, req.user.id);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not mark message read' });
  }
});

module.exports = router;
