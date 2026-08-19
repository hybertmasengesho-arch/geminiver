const express = require('express');
const { getUserById, updateUserProfile, getPublicProfile, getOverallRanking } = require('../db');
const { requireAuth, blockIfSuspended } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const URL_RE = /^https?:\/\/.+/i;

function normalizeSocialUrl(value, platform) {
  const v = (value || '').trim();
  if (!v) return '';
  if (URL_RE.test(v)) return v;
  // Let people type just "@handle" or "handle" — turn it into a real link
  // so it always renders as a clickable URL on the public profile view.
  const handle = encodeURIComponent(v.replace(/^@/, ''));
  if (platform === 'tiktok') return `https://www.tiktok.com/@${handle}`;
  return `https://www.instagram.com/${handle}`;
}

// GET /api/profile/me — your own full account center details.
router.get('/me', async (req, res) => {
  try {
    res.json({ profile: await getUserById(req.user.id) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load your profile' });
  }
});

// PUT /api/profile/me  { name, phone, instagram, tiktok }
// instagram/tiktok accept a full URL or a bare handle — bare handles are
// turned into a real profile link automatically.
router.put('/me', blockIfSuspended, async (req, res) => {
  const { name, phone, instagram, tiktok } = req.body || {};
  if (name !== undefined && String(name).trim().length > 100) {
    return res.status(400).json({ error: 'Name is too long (100 characters max).' });
  }
  if (phone !== undefined && String(phone).trim().length > 30) {
    return res.status(400).json({ error: 'Phone number is too long.' });
  }
  try {
    const updated = await updateUserProfile(req.user.id, {
      name: name !== undefined ? String(name).trim() : undefined,
      phone: phone !== undefined ? String(phone).trim() : undefined,
      instagramUrl: instagram !== undefined ? normalizeSocialUrl(instagram, 'instagram') : undefined,
      tiktokUrl: tiktok !== undefined ? normalizeSocialUrl(tiktok, 'tiktok') : undefined
    });
    if (!updated) return res.status(404).json({ error: 'Account not found' });
    res.json({ ok: true, profile: updated });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not save your profile' });
  }
});

// GET /api/profile/my-rank — any signed-in user: their own overall rank
// (same ranking the admin's Ranking tab shows), used to draw the small
// yellow rank badge on Courses.
router.get('/my-rank', async (req, res) => {
  try {
    const ranking = await getOverallRanking();
    const total = ranking.length;
    const mine = ranking.find(r => r.id === req.user.id);
    if (!mine) return res.json({ rank: null, total });
    res.json({ rank: mine.rank, total, matrix: mine.matrix, reasoning: mine.reasoning, prep30: mine.prep30 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load your rank' });
  }
});

// GET /api/profile/:id/public — what shows up when someone clicks an
// author's name from Public Files. Only the fields the person chose to
// fill in are ever returned; there's no way to fetch a password or email
// through this route.
router.get('/:id/public', async (req, res) => {
  try {
    const profile = await getPublicProfile(req.params.id);
    if (!profile) return res.status(404).json({ error: 'User not found' });
    res.json({ profile });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load profile' });
  }
});

module.exports = router;
