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
const { requireAuth, requireFacilitator, blockIfSuspended } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// 'gemini-flash-latest' is a Google-maintained alias that always points at
// their current stable Flash model — avoids hardcoding a specific version
// (like gemini-2.5-flash) that Google later retires out from under us.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

const PROVIDER = GEMINI_API_KEY ? 'gemini' : (ANTHROPIC_API_KEY ? 'anthropic' : null);

const SYSTEM_PROMPT =
  "You are the Study Helper inside Reasoning Hub, a study app covering linear algebra, calculus, logic, and electrical engineering topics " +
  "(electromagnetism, circuits, instrumentation, machines, control systems, communications) plus general math and science questions learners ask. " +
  "Be concise but complete — a full worked solution or explanation, not just a one-liner. For a law or formula (e.g. Faraday's law, Coulomb's law), " +
  "state it, define the terms, and give a short example. For arithmetic or algebra (addition, equations, etc.), show the steps and the final answer plainly. " +
  "If screen context is provided, it's the exercise question currently on the learner's screen — use it to give a relevant hint, " +
  "but don't just state which option is correct; help them reason toward it unless they explicitly ask you to just tell them the answer. " +
  "That restriction only applies to the multiple-choice question on screen — answer any other question directly and fully.";

router.get('/status', (req, res) => {
  res.json({ enabled: !!PROVIDER, provider: PROVIDER });
});

async function callWithTimeout(fn, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function askGemini(userContent, maxTokens, systemPrompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: systemPrompt || SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: userContent }] }],
    generationConfig: { maxOutputTokens: maxTokens || 500 }
  });
  // Netlify Functions have a hard execution ceiling (10s on the free tier);
  // an unbounded fetch that runs past it gets killed by the platform and
  // the browser just sees a bare 502 with no useful message. Bounding our
  // own fetch to 9s means WE catch that first and can return a clear error
  // instead. One quick retry absorbs an occasional transient hiccup/429.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await callWithTimeout((signal) => fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal
      }), 9000);
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        const err = new Error(`Gemini API error ${res.status}: ${detail}`);
        err.status = res.status;
        throw err;
      }
      const data = await res.json();
      const candidate = data.candidates && data.candidates[0];
      const parts = candidate && candidate.content && candidate.content.parts;
      const text = parts ? parts.map(p => p.text || '').join('').trim() : '';
      if (!text && candidate && candidate.finishReason && candidate.finishReason !== 'STOP') {
        throw Object.assign(new Error(`Gemini stopped early: ${candidate.finishReason}`), { status: 200 });
      }
      return text;
    } catch (e) {
      const retryable = e.name === 'AbortError' || e.status === 429 || e.status === 503 || e.status >= 500;
      if (attempt === 0 && retryable) continue;
      if (e.name === 'AbortError') throw Object.assign(new Error('Gemini request timed out'), { timeout: true });
      throw e;
    }
  }
}

async function askAnthropic(userContent, maxTokens, systemPrompt) {
  try {
    const res = await callWithTimeout((signal) => fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: maxTokens || 500,
        system: systemPrompt || SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }]
      }),
      signal
    }), 9000);
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Anthropic API error ${res.status}: ${detail}`);
    }
    const data = await res.json();
    return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  } catch (e) {
    if (e.name === 'AbortError') throw Object.assign(new Error('Anthropic request timed out'), { timeout: true });
    throw e;
  }
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
    if (e.timeout) {
      return res.status(504).json({ error: "That took too long to answer — try a shorter or simpler question." });
    }
    if (e.status === 429) {
      return res.status(429).json({ error: "The study helper is getting a lot of requests right now — try again in a few seconds." });
    }
    res.status(502).json({ error: 'The study helper is temporarily unavailable.' });
  }
});

const NOTE_SYSTEM_PROMPT =
  "You write study notes for Reasoning Hub, structured like a short textbook chapter: a brief intro, clearly labeled sections with " +
  "definitions/formulas/laws where relevant, a short worked example, and a one-paragraph summary. Use plain text with line breaks between " +
  "sections (no markdown tables or images — this becomes a saved note a facilitator will publish as-is or edit first). Keep it thorough but readable.";

// POST /api/assistant/draft-note  { topic } — facilitator/admin only. Asks
// the same AI provider as /ask to produce a full draft note body for a
// given topic, which the facilitator then reviews/edits and saves via
// POST /api/notes. This doesn't create the note itself — it only returns
// text for the Notes editor to prefill, so a bad draft never gets published
// without a human looking at it first.
router.post('/draft-note', blockIfSuspended, requireFacilitator, async (req, res) => {
  if (!PROVIDER) return res.status(503).json({ error: 'The study helper has no AI provider configured (set GEMINI_API_KEY or ANTHROPIC_API_KEY).' });
  const topic = (req.body && req.body.topic ? String(req.body.topic) : '').trim().slice(0, 300);
  if (!topic) return res.status(400).json({ error: 'topic is required.' });
  const prompt = `Write a study note on: ${topic}`;
  try {
    const body = PROVIDER === 'gemini'
      ? await askGemini(prompt, 1400, NOTE_SYSTEM_PROMPT)
      : await askAnthropic(prompt, 1400, NOTE_SYSTEM_PROMPT);
    res.json({ title: topic, body: body || 'The study helper could not draft this — try rephrasing the topic.' });
  } catch (e) {
    console.error('[assistant] draft-note failed:', e.message);
    if (e.timeout) return res.status(504).json({ error: 'That took too long to draft — try a narrower topic.' });
    res.status(502).json({ error: 'The study helper is temporarily unavailable.' });
  }
});

module.exports = router;
