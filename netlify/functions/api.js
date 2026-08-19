const serverless = require('serverless-http');
const app = require('../../app');

// basePath strips the "/.netlify/functions/api" prefix Netlify's redirect
// target adds, before Express ever sees the request — without this, every
// route mounted at app.use('/api/...') can 404 depending on exactly how
// Netlify passes the path through. Harmless if the prefix isn't present.
module.exports.handler = serverless(app, { basePath: '/.netlify/functions/api' });
