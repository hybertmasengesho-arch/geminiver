// routes/screenshare.js — signaling for peer-to-peer screen sharing.
//
// No websocket server exists in this app (Netlify Functions are
// request/response, not long-lived), so signaling happens by both sides
// polling one row in screen_share_sessions: the host writes an SDP offer
// and its ICE candidates, the viewer (an admin) writes back an SDP answer
// and its own candidates, and the actual video never touches this server —
// it flows directly between the two browsers once WebRTC connects (via
// public STUN servers; see public/js/screenshare.js).
const express = require('express');
const {
  createScreenShareSession, getScreenShareSession, listWaitingScreenShareSessions,
  setScreenShareOffer, joinScreenShareSession, setScreenShareAnswer, addScreenShareCandidate,
  endScreenShareSession, listAdminIds, insertMessage
} = require('../db');
const { requireAuth, requireAdmin, blockIfSuspended } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function sessionView(session, role) {
  if (!session) return null;
  return {
    code: session.code,
    status: session.status,
    hostId: session.host_id,
    viewerId: session.viewer_id,
    hostName: session.users ? (session.users.name || session.users.email) : null,
    // Each side only needs the OTHER side's SDP/candidates.
    offerSdp: role === 'viewer' ? session.offer_sdp : undefined,
    answerSdp: role === 'host' ? session.answer_sdp : undefined,
    candidates: role === 'viewer' ? (session.host_candidates || []) : (session.viewer_candidates || [])
  };
}

// POST /api/screenshare/start — begin a session as the host (any signed-in,
// not-suspended user). Notifies every admin so they see a "join" option.
router.post('/start', blockIfSuspended, async (req, res) => {
  try {
    const session = await createScreenShareSession(req.user.id);
    const admins = (await listAdminIds()).filter(id => id !== req.user.id);
    const body = `${req.user.email} started a screen share — code ${session.code}. Open Admin → Screen share to join.`;
    admins.forEach(id => insertMessage({ recipientId: id, senderId: req.user.id, body }).catch(() => {}));
    res.status(201).json({ code: session.code });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Could not start screen share' });
  }
});

// GET /api/screenshare/waiting — admin only: sessions currently open (with
// or without a viewer yet) so the admin panel can list them to join.
router.get('/waiting', requireAdmin, async (req, res) => {
  try {
    res.json({ sessions: await listWaitingScreenShareSessions() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load screen-share sessions' });
  }
});

// POST /api/screenshare/:code/offer  { sdp } — host only.
router.post('/:code/offer', blockIfSuspended, async (req, res) => {
  try {
    const session = await getScreenShareSession(req.params.code);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.host_id !== req.user.id) return res.status(403).json({ error: 'Not your session' });
    await setScreenShareOffer(req.params.code, req.body && req.body.sdp);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not save offer' });
  }
});

// POST /api/screenshare/:code/join — admin only: claims the session as viewer.
router.post('/:code/join', requireAdmin, async (req, res) => {
  try {
    const session = await joinScreenShareSession(req.params.code, req.user.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(sessionView(session, 'viewer'));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not join session' });
  }
});

// POST /api/screenshare/:code/answer  { sdp } — viewer (admin) only.
router.post('/:code/answer', requireAdmin, async (req, res) => {
  try {
    const session = await getScreenShareSession(req.params.code);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    await setScreenShareAnswer(req.params.code, req.body && req.body.sdp);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not save answer' });
  }
});

// POST /api/screenshare/:code/candidate  { role: 'host'|'viewer', candidate }
router.post('/:code/candidate', blockIfSuspended, async (req, res) => {
  try {
    const session = await getScreenShareSession(req.params.code);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const role = req.body && req.body.role === 'host' ? 'host' : 'viewer';
    if (role === 'host' && session.host_id !== req.user.id) return res.status(403).json({ error: 'Not your session' });
    if (role === 'viewer' && session.viewer_id !== req.user.id) return res.status(403).json({ error: 'Not your session' });
    await addScreenShareCandidate(req.params.code, role, req.body && req.body.candidate);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not save candidate' });
  }
});

// GET /api/screenshare/:code  — poll for the other side's SDP/candidates.
// role query param ('host' or 'viewer') controls which fields come back.
router.get('/:code', async (req, res) => {
  try {
    const session = await getScreenShareSession(req.params.code);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const isHost = session.host_id === req.user.id;
    const isViewer = session.viewer_id === req.user.id;
    if (!isHost && !isViewer && req.user.role !== 'admin') return res.status(403).json({ error: 'Not part of this session' });
    const role = isHost ? 'host' : 'viewer';
    res.json(sessionView(session, role));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load session' });
  }
});

// POST /api/screenshare/:code/end — either side ends it.
router.post('/:code/end', async (req, res) => {
  try {
    const session = await getScreenShareSession(req.params.code);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.host_id !== req.user.id && session.viewer_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not part of this session' });
    }
    await endScreenShareSession(req.params.code);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not end session' });
  }
});

module.exports = router;
