// routes/assistant.js — the "Study Helper" chat widget's backend.
//
// Math calculation and reading the current on-screen question happen
// entirely client-side (public/js/study-helper.js) — no network call, no
// API key needed for those. This route only handles free-form questions
// ("what does this term mean", "explain why B is wrong").
//
// Supports two providers, auto-detected from whichever env var is set:
//   GEMINI_API_KEY    — Google Gemini. Has a genuinely free tier (no card
//                        required) — see ai.google.dev. Recommended default.
//   ANTHROPIC_API_KEY — Claude. Paid only (no free API tier), higher quality.
// If GEMINI_API_KEY is set, Gemini is used even if an Anthropic key is also
// present. If neither is set, /status reports disabled and the widget stays
// honest about that instead of pretending to answer.
const express = require('express');
const { requireAuth, blockIfSuspended } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

const PROVIDER = GEMINI_API_KEY ? 'gemini' : (ANTHROPIC_API_KEY ? 'anthropic' : null);

const SYSTEM_PROMPT =
  "You are the Study Helper inside Reasoning Hub, a study app. Be concise (a few sentences, or a short worked calculation) and encouraging. " +
  "If screen context is provided, it's the exercise question currently on the learner's screen — use it to give a relevant hint or explanation, " +
  "but don't just state which option is correct; help them reason toward it unless they explicitly ask you to just tell them the answer. " +
  "For math, show the key steps briefly.";

router.get('/status', (req, res) => {
  res.json({ enabled: !!PROVIDER, provider: PROVIDER });
});

async function askGemini(userContent) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: userContent }] }],
      generationConfig: { maxOutputTokens: 500 }
    })
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Gemini API error ${res.status}: ${detail}`);
  }
  const data = await res.json();
  const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  return parts ? parts.map(p => p.text || '').join('').trim() : '';
}

async function askAnthropic(userContent) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }]
    })
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Anthropic API error ${res.status}: ${detail}`);
  }
  const data = await res.json();
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

// POST /api/assistant/ask  { message, screenContext }
// screenContext is whatever the widget read off the current page (e.g. the
// visible question + its options) — sent as extra context, never as a
// source of the correct answer, since the frontend never has that until
// after the learner checks their own answer.
router.post('/ask', blockIfSuspended, async (req, res) => {
  if (!PROVIDER) {
    return res.json({ enabled: false, reply: null });
  }
  const message = (req.body && req.body.message ? String(req.body.message) : '').trim().slice(0, 1500);
  const screenContext = (req.body && req.body.screenContext ? String(req.body.screenContext) : '').slice(0, 2000);
  if (!message) return res.status(400).json({ error: 'message is required.' });

  const userContent = screenContext
    ? `Currently on screen:\n${screenContext}\n\nQuestion: ${message}`
    : message;

  try {
    const reply = PROVIDER === 'gemini' ? await askGemini(userContent) : await askAnthropic(userContent);
    res.json({ enabled: true, provider: PROVIDER, reply: reply || "I couldn't come up with an answer to that — try rephrasing?" });
  } catch (e) {
    console.error('[assistant] request failed:', e.message);
    res.status(502).json({ error: 'The study helper is temporarily unavailable.' });
  }
});

module.exports = router;
