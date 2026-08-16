const express = require('express');
const {
  createBook, listBooks, getBookById, updateBook, deleteBook,
  createQuestion, listQuestionsForBook, getQuestionById, updateQuestion, deleteQuestion,
  kvSet
} = require('../db');
const { requireAuth, requireAdmin, requireFacilitator, blockIfSuspended } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function validOptions(options) {
  return Array.isArray(options) && options.length >= 2 && options.length <= 8
    && options.every(o => o && typeof o.id === 'string' && o.id.trim() && typeof o.text === 'string' && o.text.trim());
}

/* ---------------- books ---------------- */

// GET /api/content/books — any signed-in user (learner picking a book, or
// facilitator managing content).
router.get('/books', async (req, res) => {
  try {
    res.json({ books: await listBooks() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load books' });
  }
});

router.post('/books', blockIfSuspended, requireFacilitator, async (req, res) => {
  const title = (req.body && req.body.title ? String(req.body.title).trim() : '').slice(0, 200);
  if (!title) return res.status(400).json({ error: 'Title is required.' });
  try {
    const book = await createBook({
      title, author: req.body.author ? String(req.body.author).trim().slice(0, 150) : null,
      description: req.body.description ? String(req.body.description).trim().slice(0, 2000) : null,
      createdBy: req.user.id
    });
    res.status(201).json({ book });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not create book' });
  }
});

router.patch('/books/:id', blockIfSuspended, requireFacilitator, async (req, res) => {
  try {
    const book = await getBookById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Book not found' });
    const patch = {};
    if (req.body.title !== undefined) patch.title = String(req.body.title).trim().slice(0, 200);
    if (req.body.author !== undefined) patch.author = req.body.author ? String(req.body.author).trim().slice(0, 150) : null;
    if (req.body.description !== undefined) patch.description = req.body.description ? String(req.body.description).trim().slice(0, 2000) : null;
    await updateBook(book.id, patch);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not update book' });
  }
});

// Deleting a book removes every question in it (ON DELETE CASCADE) —
// kept admin-only since it's the more destructive of the two delete actions.
router.delete('/books/:id', blockIfSuspended, requireAdmin, async (req, res) => {
  try {
    await deleteBook(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not delete book' });
  }
});

/* ---------------- questions ---------------- */

// GET /api/content/books/:id/questions — learners get options without the
// answer; facilitator/admin get everything (for editing).
router.get('/books/:id/questions', async (req, res) => {
  const isManager = req.user.role === 'admin' || req.user.role === 'facilitator';
  try {
    const questions = await listQuestionsForBook(req.params.id, isManager);
    res.json({ questions });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load questions' });
  }
});

router.post('/questions', blockIfSuspended, requireFacilitator, async (req, res) => {
  const { bookId, questionText, options, correctOptionId, explanation, reference, color } = req.body || {};
  if (!bookId) return res.status(400).json({ error: 'bookId is required.' });
  if (!questionText || !String(questionText).trim()) return res.status(400).json({ error: 'Question text is required.' });
  if (!validOptions(options)) return res.status(400).json({ error: 'Provide 2–8 options, each with an id and text.' });
  if (!correctOptionId || !options.some(o => o.id === correctOptionId)) {
    return res.status(400).json({ error: 'correctOptionId must match one of the option ids.' });
  }
  if (color && !/^#[0-9a-f]{6}$/i.test(color)) return res.status(400).json({ error: 'color must be a hex value like #2F6F4F.' });
  try {
    const question = await createQuestion({
      bookId, questionText: String(questionText).trim().slice(0, 1000), options, correctOptionId,
      explanation: explanation ? String(explanation).trim().slice(0, 2000) : null,
      reference: reference ? String(reference).trim().slice(0, 500) : null,
      color: color || '#2F6F4F', createdBy: req.user.id
    });
    res.status(201).json({ question });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not create question' });
  }
});

router.patch('/questions/:id', blockIfSuspended, requireFacilitator, async (req, res) => {
  try {
    const question = await getQuestionById(req.params.id);
    if (!question) return res.status(404).json({ error: 'Question not found' });
    const { questionText, options, correctOptionId, explanation, reference, color } = req.body || {};
    if (options !== undefined && !validOptions(options)) {
      return res.status(400).json({ error: 'Provide 2–8 options, each with an id and text.' });
    }
    const effectiveOptions = options !== undefined ? options : question.options;
    if (correctOptionId !== undefined && !effectiveOptions.some(o => o.id === correctOptionId)) {
      return res.status(400).json({ error: 'correctOptionId must match one of the option ids.' });
    }
    if (color !== undefined && color && !/^#[0-9a-f]{6}$/i.test(color)) {
      return res.status(400).json({ error: 'color must be a hex value like #2F6F4F.' });
    }
    await updateQuestion(question.id, {
      questionText: questionText !== undefined ? String(questionText).trim().slice(0, 1000) : undefined,
      options, correctOptionId,
      explanation: explanation !== undefined ? (explanation ? String(explanation).trim().slice(0, 2000) : null) : undefined,
      reference: reference !== undefined ? (reference ? String(reference).trim().slice(0, 500) : null) : undefined,
      color
    });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not update question' });
  }
});

router.delete('/questions/:id', blockIfSuspended, requireFacilitator, async (req, res) => {
  try {
    await deleteQuestion(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not delete question' });
  }
});

// POST /api/content/questions/:id/check  { optionId } — any signed-in
// learner. This is the only place the correct answer is ever revealed, and
// only after they've picked something. Also records the result into the
// existing kv store (app='exercises') so a "your progress" view is possible
// later without a dedicated attempts table.
router.post('/questions/:id/check', blockIfSuspended, async (req, res) => {
  const optionId = req.body && req.body.optionId;
  if (!optionId) return res.status(400).json({ error: 'optionId is required.' });
  try {
    const question = await getQuestionById(req.params.id);
    if (!question) return res.status(404).json({ error: 'Question not found' });
    const correct = optionId === question.correct_option_id;
    kvSet(req.user.id, 'exercises', 'q' + question.id, JSON.stringify({
      correct, selectedOptionId: optionId, at: new Date().toISOString()
    })).catch(() => {}); // progress tracking is a nice-to-have, never block the actual answer check on it
    res.json({
      correct, correctOptionId: question.correct_option_id,
      explanation: question.explanation, reference: question.reference, color: question.color
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not check answer' });
  }
});

module.exports = router;
