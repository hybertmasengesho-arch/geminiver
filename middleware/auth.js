const jwt = require('jsonwebtoken');
const { getUserById } = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
if (process.env.JWT_SECRET === undefined) {
  console.warn('[warn] JWT_SECRET is not set — using an insecure default. Set it in .env before deploying.');
}

function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await getUserById(payload.id);
    if (!user) return res.status(401).json({ error: 'User no longer exists' });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// Content management (books/questions) — a facilitator has this without
// needing full admin (account management, suspensions, etc).
function requireFacilitator(req, res, next) {
  if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'facilitator')) {
    return res.status(403).json({ error: 'Facilitator or admin access required' });
  }
  next();
}

// Blocks any action that creates or changes data — saving tracker progress,
// uploading a file, making a file public — for a paused account. Suspended
// users can still log in and view their own existing data (requireAuth alone
// still passes), they just can't write anything new until an admin lifts it.
function blockIfSuspended(req, res, next) {
  if (req.user && req.user.suspended) {
    return res.status(403).json({ error: 'Your account has been paused by an admin. Contact them to restore access.' });
  }
  next();
}

module.exports = { signToken, requireAuth, requireAdmin, requireFacilitator, blockIfSuspended, JWT_SECRET };
