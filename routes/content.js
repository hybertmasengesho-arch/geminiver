const express = require('express');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const {
  createBook, listBooks, listBooksForLearner, getBookById, updateBook, deleteBook, updateBookVisibility,
  updateBookCover, clearBookCover, updateBookDocument, clearBookDocument,
  requestBookAccess, hasApprovedBookAccess, listIncomingBookAccessRequests, decideBookAccessRequest,
  createQuestion, listQuestionsForBook, getQuestionById, updateQuestion, deleteQuestion,
  getBookMarks, listMyPositions,
  kvSet, isAcceptedTeamMember, insertMessage, uploadFileToStorage, getFileSignedUrl
} = require('../db');
const { requireAuth, requireAdmin, requireFacilitator, blockIfSuspended } = require('../middleware/auth');

function isManager(user) { return user.role === 'admin' || user.role === 'facilitator'; }

// Same visibility rule the learner questions route already applies —
// pulled out so the cover-photo and document routes can share it instead
// of duplicating the private/team/restricted checks.
async function assertLearnerCanOpenBook(book, user) {
  if (isManager(user) || book.created_by === user.id) return true;
  if (book.team_id) {
    const member = await isAcceptedTeamMember(book.team_id, user.id);
    if (!member) throw Object.assign(new Error('This book is limited to a team you are not a member of.'), { status: 403 });
    return true;
  }
  if (!book.is_public) throw Object.assign(new Error('This book is private.'), { status: 403 });
  if (book.access_mode === 'restricted') {
    const approved = await hasApprovedBookAccess(book.id, user.id);
    if (!approved) throw Object.assign(new Error('This book requires approval — request access first.'), { status: 403 });
  }
  return true;
}

const router = express.Router();
router.use(requireAuth);

/* ---------------- book cover photo + attached document ---------------- */

const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const MAX_COVER_SIZE = 5 * 1024 * 1024; // 5MB, matches the file-upload cap elsewhere

const coverUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_COVER_SIZE },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (IMAGE_MIME.has(file.mimetype) || IMAGE_EXT.has(ext)) return cb(null, true);
    cb(new Error('Cover must be a JPG, PNG, WEBP, or GIF image.'));
  }
});

// Same document types the general file uploader accepts (see routes/files.js) —
// a book's attached document is the source material the exercises are drawn from.
const DOC_MIME = new Set([
  'application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.oasis.opendocument.text', 'text/plain', 'text/markdown', 'text/csv', 'application/rtf'
]);
const DOC_EXT = new Set(['.pdf', '.doc', '.docx', '.odt', '.txt', '.md', '.csv', '.rtf']);
const MAX_DOC_SIZE = 5 * 1024 * 1024;

const docUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOC_SIZE },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (DOC_MIME.has(file.mimetype) || DOC_EXT.has(ext)) return cb(null, true);
    cb(new Error('Only PDF, Word, ODT, RTF, TXT, MD, or CSV files are allowed.'));
  }
});

// POST /api/content/books/:id/cover  (multipart, field "cover") — facilitator/admin
router.post('/books/:id/cover', blockIfSuspended, requireFacilitator, (req, res) => {
  coverUpload.single('cover')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    if (!req.file) return res.status(400).json({ error: 'No image received' });
    try {
      const book = await getBookById(req.params.id);
      if (!book) return res.status(404).json({ error: 'Book not found' });
      const random = crypto.randomBytes(16).toString('hex');
      const storagePath = `book-covers/${book.id}-${random}${path.extname(req.file.originalname).toLowerCase()}`;
      await uploadFileToStorage(storagePath, req.file.buffer, req.file.mimetype || 'image/jpeg');
      await updateBookCover(book.id, storagePath);
      res.status(201).json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message || 'Could not save cover image' });
    }
  });
});

// GET /api/content/books/:id/cover — anyone who can open the book (same
// rule as its questions). Redirects to a short-lived signed Storage URL.
router.get('/books/:id/cover', async (req, res) => {
  try {
    const book = await getBookById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Book not found' });
    if (!book.cover_storage_path) return res.status(404).json({ error: 'This book has no cover image.' });
    await assertLearnerCanOpenBook(book, req.user);
    const url = await getFileSignedUrl(book.cover_storage_path);
    res.redirect(url);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Could not load cover image' });
  }
});

// DELETE /api/content/books/:id/cover — facilitator/admin
router.delete('/books/:id/cover', blockIfSuspended, requireFacilitator, async (req, res) => {
  try {
    const book = await getBookById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Book not found' });
    await clearBookCover(book.id);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not remove cover image' });
  }
});

// POST /api/content/books/:id/document  (multipart, field "document") — facilitator/admin
router.post('/books/:id/document', blockIfSuspended, requireFacilitator, (req, res) => {
  docUpload.single('document')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    if (!req.file) return res.status(400).json({ error: 'No document received' });
    try {
      const book = await getBookById(req.params.id);
      if (!book) return res.status(404).json({ error: 'Book not found' });
      const random = crypto.randomBytes(16).toString('hex');
      const storagePath = `book-documents/${book.id}-${random}${path.extname(req.file.originalname).toLowerCase()}`;
      await uploadFileToStorage(storagePath, req.file.buffer, req.file.mimetype || 'application/octet-stream');
      await updateBookDocument(book.id, {
        storagePath, originalName: req.file.originalname,
        mimeType: req.file.mimetype || 'application/octet-stream', sizeBytes: req.file.size
      });
      res.status(201).json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message || 'Could not save document' });
    }
  });
});

// GET /api/content/books/:id/document — anyone who can open the book;
// redirects to a short-lived signed Storage URL, same pattern as file
// downloads elsewhere in the app.
router.get('/books/:id/document', async (req, res) => {
  try {
    const book = await getBookById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Book not found' });
    if (!book.document_storage_path) return res.status(404).json({ error: 'This book has no attached document.' });
    await assertLearnerCanOpenBook(book, req.user);
    const url = await getFileSignedUrl(book.document_storage_path);
    res.redirect(url);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Could not load document' });
  }
});

// DELETE /api/content/books/:id/document — facilitator/admin
router.delete('/books/:id/document', blockIfSuspended, requireFacilitator, async (req, res) => {
  try {
    const book = await getBookById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Book not found' });
    await clearBookDocument(book.id);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not remove document' });
  }
});

function validOptions(options) {
  return Array.isArray(options) && options.length >= 2 && options.length <= 8
    && options.every(o => o && typeof o.id === 'string' && o.id.trim() && typeof o.text === 'string' && o.text.trim());
}

/* ---------------- books ---------------- */

// GET /api/content/books — any signed-in user (learner picking a book, or
// facilitator managing content).
router.get('/books', async (req, res) => {
  try {
    const books = isManager(req.user) ? await listBooks() : await listBooksForLearner(req.user.id);
    res.json({ books });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load books' });
  }
});

// PATCH /api/content/books/:id/visibility  { isPublic?, accessMode?, teamId? } — facilitator/admin
router.patch('/books/:id/visibility', blockIfSuspended, requireFacilitator, async (req, res) => {
  try {
    const book = await getBookById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Book not found' });
    if (req.body.teamId) {
      const member = await isAcceptedTeamMember(req.body.teamId, req.user.id);
      if (!member) return res.status(403).json({ error: 'You are not an accepted member of that team.' });
    }
    await updateBookVisibility(book.id, { isPublic: req.body.isPublic, accessMode: req.body.accessMode, teamId: req.body.teamId });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not update visibility' });
  }
});

// POST /api/content/books/:id/request-access — learner requests approval
// on a restricted public book (the "reader" access tier).
router.post('/books/:id/request-access', blockIfSuspended, async (req, res) => {
  try {
    const book = await getBookById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Book not found' });
    if (!book.is_public || book.access_mode !== 'restricted') return res.status(400).json({ error: 'This book does not require a request.' });
    await requestBookAccess(book.id, req.user.id);
    if (book.created_by) {
      insertMessage({
        recipientId: book.created_by, senderId: req.user.id,
        body: `${req.user.email} requested access to your book "${book.title}". Review it from Content.`
      }).catch(() => {});
    }
    res.status(201).json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not send request' });
  }
});

// GET/POST for reviewing book access requests — facilitator/admin manage
// content collectively, same pattern as notes.
router.get('/books/access-requests/incoming', requireFacilitator, async (req, res) => {
  try {
    res.json({ requests: await listIncomingBookAccessRequests() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load access requests' });
  }
});

router.post('/books/access-requests/:id/decide', blockIfSuspended, requireFacilitator, async (req, res) => {
  try {
    const approve = !!(req.body && req.body.approve);
    const result = await decideBookAccessRequest(req.params.id, approve);
    if (!result) return res.status(404).json({ error: 'Request not found' });
    insertMessage({
      recipientId: result.requesterId, senderId: req.user.id,
      body: approve ? 'Your request to view a book was approved — open it from Exercises now.'
                    : 'Your request to view a book was declined.'
    }).catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not decide on request' });
  }
});

const BOOK_TYPES = ['book', 'exercises', 'exercises_and_book'];
const ENV_MODES = ['default', 'custom'];
const ENV_LINE_STYLES = ['none', 'grid', 'ruled'];

router.post('/books', blockIfSuspended, requireFacilitator, async (req, res) => {
  const title = (req.body && req.body.title ? String(req.body.title).trim() : '').slice(0, 200);
  if (!title) return res.status(400).json({ error: 'Title is required.' });
  const { themeColor, passingScore, bookType, envMode, envBgColor, envLineStyle } = req.body || {};
  if (themeColor && !/^#[0-9a-f]{6}$/i.test(themeColor)) return res.status(400).json({ error: 'themeColor must be a hex value like #2F6F4F.' });
  if (passingScore !== undefined && (!Number.isFinite(Number(passingScore)) || passingScore < 0 || passingScore > 100)) {
    return res.status(400).json({ error: 'passingScore must be a number between 0 and 100.' });
  }
  if (bookType !== undefined && !BOOK_TYPES.includes(bookType)) return res.status(400).json({ error: 'bookType must be book, exercises, or exercises_and_book.' });
  if (envMode !== undefined && !ENV_MODES.includes(envMode)) return res.status(400).json({ error: 'envMode must be default or custom.' });
  if (envBgColor && !/^#[0-9a-f]{6}$/i.test(envBgColor)) return res.status(400).json({ error: 'envBgColor must be a hex value like #F6F5F1.' });
  if (envLineStyle !== undefined && !ENV_LINE_STYLES.includes(envLineStyle)) return res.status(400).json({ error: 'envLineStyle must be none, grid, or ruled.' });
  try {
    const book = await createBook({
      title, author: req.body.author ? String(req.body.author).trim().slice(0, 150) : null,
      description: req.body.description ? String(req.body.description).trim().slice(0, 2000) : null,
      createdBy: req.user.id, themeColor: themeColor || undefined,
      passingScore: passingScore !== undefined ? Number(passingScore) : undefined,
      bookType: bookType || undefined, envMode: envMode || undefined,
      envBgColor: envBgColor || undefined, envLineStyle: envLineStyle || undefined
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
    if (req.body.themeColor !== undefined && req.body.themeColor && !/^#[0-9a-f]{6}$/i.test(req.body.themeColor)) {
      return res.status(400).json({ error: 'themeColor must be a hex value like #2F6F4F.' });
    }
    if (req.body.passingScore !== undefined && (!Number.isFinite(Number(req.body.passingScore)) || req.body.passingScore < 0 || req.body.passingScore > 100)) {
      return res.status(400).json({ error: 'passingScore must be a number between 0 and 100.' });
    }
    if (req.body.bookType !== undefined && !BOOK_TYPES.includes(req.body.bookType)) return res.status(400).json({ error: 'bookType must be book, exercises, or exercises_and_book.' });
    if (req.body.envMode !== undefined && !ENV_MODES.includes(req.body.envMode)) return res.status(400).json({ error: 'envMode must be default or custom.' });
    if (req.body.envBgColor !== undefined && req.body.envBgColor && !/^#[0-9a-f]{6}$/i.test(req.body.envBgColor)) return res.status(400).json({ error: 'envBgColor must be a hex value like #F6F5F1.' });
    if (req.body.envLineStyle !== undefined && !ENV_LINE_STYLES.includes(req.body.envLineStyle)) return res.status(400).json({ error: 'envLineStyle must be none, grid, or ruled.' });
    const patch = {};
    if (req.body.title !== undefined) patch.title = String(req.body.title).trim().slice(0, 200);
    if (req.body.author !== undefined) patch.author = req.body.author ? String(req.body.author).trim().slice(0, 150) : null;
    if (req.body.description !== undefined) patch.description = req.body.description ? String(req.body.description).trim().slice(0, 2000) : null;
    if (req.body.themeColor !== undefined) patch.themeColor = req.body.themeColor || '#2F6F4F';
    if (req.body.passingScore !== undefined) patch.passingScore = Number(req.body.passingScore);
    if (req.body.bookType !== undefined) patch.bookType = req.body.bookType;
    if (req.body.envMode !== undefined) patch.envMode = req.body.envMode;
    if (req.body.envBgColor !== undefined) patch.envBgColor = req.body.envBgColor || '#F6F5F1';
    if (req.body.envLineStyle !== undefined) patch.envLineStyle = req.body.envLineStyle;
    await updateBook(book.id, patch);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not update book' });
  }
});

// Facilitators (coordinators) can delete books they created; admins can
// delete any book. Deleting removes every question in it (ON DELETE CASCADE).
router.delete('/books/:id', blockIfSuspended, requireFacilitator, async (req, res) => {
  try {
    const book = await getBookById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Book not found' });
    if (req.user.role !== 'admin' && book.created_by !== req.user.id) {
      return res.status(403).json({ error: 'You can only delete books you created.' });
    }
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
  const manager = isManager(req.user);
  try {
    if (!manager) {
      const book = await getBookById(req.params.id);
      if (!book) return res.status(404).json({ error: 'Book not found' });
      if (book.created_by !== req.user.id) {
        if (book.team_id) {
          const member = await isAcceptedTeamMember(book.team_id, req.user.id);
          if (!member) return res.status(403).json({ error: 'This book is limited to a team you are not a member of.' });
        } else if (!book.is_public) {
          return res.status(403).json({ error: 'This book is private.' });
        } else if (book.access_mode === 'restricted') {
          const approved = await hasApprovedBookAccess(book.id, req.user.id);
          if (!approved) return res.status(403).json({ error: 'This book requires approval — request access first.' });
        }
      }
    }
    const questions = await listQuestionsForBook(req.params.id, manager);
    res.json({ questions });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load questions' });
  }
});

router.post('/questions', blockIfSuspended, requireFacilitator, async (req, res) => {
  const { bookId, questionText, options, correctOptionId, explanation, reference, color, questionType, correctAnswerText } = req.body || {};
  if (!bookId) return res.status(400).json({ error: 'bookId is required.' });
  if (!questionText || !String(questionText).trim()) return res.status(400).json({ error: 'Question text is required.' });
  const qType = questionType === 'short_answer' ? 'short_answer' : 'mcq';
  if (qType === 'mcq') {
    if (!validOptions(options)) return res.status(400).json({ error: 'Provide 2–8 options, each with an id and text.' });
    if (!correctOptionId || !options.some(o => o.id === correctOptionId)) {
      return res.status(400).json({ error: 'correctOptionId must match one of the option ids.' });
    }
  } else if (!correctAnswerText || !String(correctAnswerText).trim()) {
    return res.status(400).json({ error: 'Correct answer text is required for a short-answer question.' });
  }
  if (color && !/^#[0-9a-f]{6}$/i.test(color)) return res.status(400).json({ error: 'color must be a hex value like #2F6F4F.' });
  try {
    const question = await createQuestion({
      bookId, questionText: String(questionText).trim().slice(0, 1000),
      options: qType === 'mcq' ? options : [],
      correctOptionId: qType === 'mcq' ? correctOptionId : null,
      questionType: qType,
      correctAnswerText: qType === 'short_answer' ? String(correctAnswerText).trim().slice(0, 500) : null,
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
    const { questionText, options, correctOptionId, explanation, reference, color, questionType, correctAnswerText } = req.body || {};
    const effectiveType = questionType !== undefined ? (questionType === 'short_answer' ? 'short_answer' : 'mcq') : question.question_type;
    if (effectiveType === 'mcq') {
      if (options !== undefined && !validOptions(options)) {
        return res.status(400).json({ error: 'Provide 2–8 options, each with an id and text.' });
      }
      const effectiveOptions = options !== undefined ? options : question.options;
      const effectiveCorrectOptionId = correctOptionId !== undefined ? correctOptionId : question.correct_option_id;
      if (effectiveCorrectOptionId && effectiveOptions && !effectiveOptions.some(o => o.id === effectiveCorrectOptionId)) {
        return res.status(400).json({ error: 'correctOptionId must match one of the option ids.' });
      }
    } else if (correctAnswerText !== undefined && !String(correctAnswerText).trim() && !question.correct_answer_text) {
      return res.status(400).json({ error: 'Correct answer text is required for a short-answer question.' });
    }
    if (color !== undefined && color && !/^#[0-9a-f]{6}$/i.test(color)) {
      return res.status(400).json({ error: 'color must be a hex value like #2F6F4F.' });
    }
    await updateQuestion(question.id, {
      questionText: questionText !== undefined ? String(questionText).trim().slice(0, 1000) : undefined,
      options, correctOptionId,
      questionType: questionType !== undefined ? effectiveType : undefined,
      correctAnswerText: correctAnswerText !== undefined ? String(correctAnswerText).trim().slice(0, 500) : undefined,
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

// POST /api/content/questions/:id/check  { optionId } for MCQ, or
// { answerText } for short-answer — any signed-in learner. This is the
// only place the correct answer is ever revealed, and only after they've
// answered. Also records the result into the existing kv store
// (app='exercises') so a "your progress" view is possible later without a
// dedicated attempts table.
function normalizeShortAnswer(s) {
  return String(s || '').trim().toLowerCase().replace(/[.,!?;:'"()]+/g, '').replace(/\s+/g, ' ');
}

router.post('/questions/:id/check', blockIfSuspended, async (req, res) => {
  try {
    const question = await getQuestionById(req.params.id);
    if (!question) return res.status(404).json({ error: 'Question not found' });
    let correct, payload;
    if (question.question_type === 'short_answer') {
      const answerText = req.body && req.body.answerText;
      if (!answerText || !String(answerText).trim()) return res.status(400).json({ error: 'answerText is required.' });
      correct = normalizeShortAnswer(answerText) === normalizeShortAnswer(question.correct_answer_text);
      payload = {
        correct, correctAnswerText: question.correct_answer_text,
        explanation: question.explanation, reference: question.reference, color: question.color
      };
      kvSet(req.user.id, 'exercises', 'q' + question.id, JSON.stringify({
        correct, answerText, at: new Date().toISOString()
      })).catch(() => {});
    } else {
      const optionId = req.body && req.body.optionId;
      if (!optionId) return res.status(400).json({ error: 'optionId is required.' });
      correct = optionId === question.correct_option_id;
      payload = {
        correct, correctOptionId: question.correct_option_id,
        explanation: question.explanation, reference: question.reference, color: question.color
      };
      kvSet(req.user.id, 'exercises', 'q' + question.id, JSON.stringify({
        correct, selectedOptionId: optionId, at: new Date().toISOString()
      })).catch(() => {}); // progress tracking is a nice-to-have, never block the actual answer check on it
    }
    res.json(payload);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not check answer' });
  }
});

/* ---------------- marks / positions ---------------- */

// GET /api/content/books/:id/marks — facilitator (coordinator) or admin
// only: the full gradebook for one book, best score first.
router.get('/books/:id/marks', requireFacilitator, async (req, res) => {
  try {
    const book = await getBookById(req.params.id);
    if (!book) return res.status(404).json({ error: 'Book not found' });
    const marks = await getBookMarks(book.id);
    res.json({ book: { id: book.id, title: book.title, passingScore: book.passing_score }, marks });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load marks' });
  }
});

// GET /api/content/my-positions — any signed-in learner: their own rank in
// every book they've attempted, based on marks.
router.get('/my-positions', async (req, res) => {
  try {
    res.json({ positions: await listMyPositions(req.user.id) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load your positions' });
  }
});

module.exports = router;
