// server.js — entrypoint for traditional Node hosting (Render, a VPS, or
// local dev with `npm start`). NOT used on Netlify — there, netlify/functions/api.js
// wraps the same app.js instead, and Netlify's CDN serves public/ directly.
const path = require('path');
const express = require('express');
const api = require('./app');

const app = express();
app.use(api);

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Reasoning Hub server running on http://localhost:${PORT}`);
});
