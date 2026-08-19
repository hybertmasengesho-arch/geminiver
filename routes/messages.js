const express = require('express');
const {
  listUnreadMessagesForUser, markMessageRead,
  listMessageableUsers, areTeammates, sendUserMessage, listConversation, markThreadRead, listMessageThreads
} = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/messages/unread — polled by nav.js on every page load to show
// any new message (admin popup, or a teammate's chat message) as a toast.
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

/* ---------------- user ↔ user messaging (teammates only) ---------------- */
// Anyone can message anyone they share an accepted team with — i.e. people
// who've "joined" a team together. This mirrors the file/note team-sharing
// model already in the app instead of opening messaging up site-wide.

// GET /api/messages/contacts — who the current user is allowed to message.
router.get('/contacts', async (req, res) => {
  try {
    res.json({ contacts: await listMessageableUsers(req.user.id) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load contacts' });
  }
});

// GET /api/messages/threads — inbox: one row per conversation, newest first.
router.get('/threads', async (req, res) => {
  try {
    res.json({ threads: await listMessageThreads(req.user.id) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load conversations' });
  }
});

// GET /api/messages/thread/:userId — full history with one person; marks
// their messages to us as read as a side effect of opening it.
router.get('/thread/:userId', async (req, res) => {
  try {
    const otherId = Number(req.params.userId);
    const messages = await listConversation(req.user.id, otherId);
    await markThreadRead(req.user.id, otherId);
    res.json({ messages });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load conversation' });
  }
});

// POST /api/messages/thread/:userId — send a message. 403s if the two of
// you have never joined a team together.
router.post('/thread/:userId', async (req, res) => {
  try {
    const otherId = Number(req.params.userId);
    const body = (req.body.body || '').trim();
    if (!body) return res.status(400).json({ error: 'Message cannot be empty' });
    if (otherId === req.user.id) return res.status(400).json({ error: "You can't message yourself" });
    if (!(await areTeammates(req.user.id, otherId))) {
      return res.status(403).json({ error: "You can only message people you've joined a team with" });
    }
    const msg = await sendUserMessage(req.user.id, otherId, body);
    res.json({ message: msg });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not send message' });
  }
});

module.exports = router;
