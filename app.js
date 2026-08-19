// app.js — the API-only Express app: auth, kv, admin, files, health.
// No static file serving and no app.listen() here — server.js wraps this
// for traditional Node hosting, netlify/functions/api.js wraps it for Netlify.
require('dotenv').config();
const express = require('express');
const cors = require('cors');

require('./db'); // connects to Supabase — run supabase/schema.sql once first to create the tables

const authRoutes = require('./routes/auth');
const kvRoutes = require('./routes/kv');
const adminRoutes = require('./routes/admin');
const filesRoutes = require('./routes/files');
const messagesRoutes = require('./routes/messages');
const profileRoutes = require('./routes/profile');
const teamsRoutes = require('./routes/teams');
const contentRoutes = require('./routes/content');
const notesRoutes = require('./routes/notes');
const assistantRoutes = require('./routes/assistant');
const screenshareRoutes = require('./routes/screenshare');
const accountShareRoutes = require('./routes/account-share');

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/kv', kvRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/files', filesRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/teams', teamsRoutes);
app.use('/api/content', contentRoutes);
app.use('/api/notes', notesRoutes);
app.use('/api/assistant', assistantRoutes);
app.use('/api/screenshare', screenshareRoutes);
app.use('/api/account-share', accountShareRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Any /api/* path that didn't match a route above — respond with JSON, not
// Express's default HTML 404 page.
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Last-resort error handler.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

module.exports = app;
