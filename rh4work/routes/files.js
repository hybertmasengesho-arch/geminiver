const express = require('express');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const {
  insertFileRecord, getFileById, listFilesForOwner, listPublicFiles,
  updateFilePublic, updateFileDetails, updateFileAccessMode, deleteFileRecord, uploadFileToStorage, getFileSignedUrl, countFilesForOwner,
  requestFileAccess, listIncomingAccessRequests, decideAccessRequest, hasApprovedAccess, insertMessage,
  isAcceptedTeamMember, updateFileTeam
} = require('../db');
const { requireAuth, blockIfSuspended } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Documents and plain text only — explicitly no video/audio/image.
const ALLOWED_MIME = new Set([
  'application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.oasis.opendocument.text', 'text/plain', 'text/markdown', 'text/csv', 'application/rtf'
]);
const ALLOWED_EXT = new Set(['.pdf', '.doc', '.docx', '.odt', '.txt', '.md', '.csv', '.rtf']);
const MAX_SIZE = 5 * 1024 * 1024; // 5MB — Netlify Functions cap request bodies around 6MB for
                                   // synchronous invocations; 5MB stays safely under that.

// Uploads land in memory (not disk — no persistent disk exists on Netlify),
// then get streamed straight into the Supabase Storage bucket.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_MIME.has(file.mimetype) || ALLOWED_EXT.has(ext)) return cb(null, true);
    cb(new Error('Only PDF, Word, ODT, RTF, TXT, MD, or CSV files are allowed.'));
  }
});

// POST /api/files/upload  (multipart: field "file", optional field "isPublic")
router.post('/upload', blockIfSuspended, async (req, res) => {
  // Check the admin-set cap before touching the multipart body at all —
  // cheap, and avoids wasting a Storage upload that would just get rejected.
  try {
    const current = await countFilesForOwner(req.user.id);
    const limit = req.user.max_files == null ? 10 : req.user.max_files;
    if (current >= limit) {
      return res.status(403).json({ error: `You've reached your saved-document limit (${limit}). Delete one first, or ask an admin to raise your limit.` });
    }
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Could not check your document limit.' });
  }

  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    if (!req.file) return res.status(400).json({ error: 'No file received' });

    const isPublic = req.body.isPublic === 'true' || req.body.isPublic === '1';
    const accessMode = isPublic && req.body.accessMode === 'restricted' ? 'restricted' : 'open';
    const teamId = req.body.teamId ? Number(req.body.teamId) : null;
    if (teamId) {
      const isMember = await isAcceptedTeamMember(teamId, req.user.id);
      if (!isMember) return res.status(403).json({ error: 'You are not an accepted member of that team.' });
    }
    const random = crypto.randomBytes(16).toString('hex');
    const storagePath = `${req.user.id}/${random}${path.extname(req.file.originalname).toLowerCase()}`;

    try {
      await uploadFileToStorage(storagePath, req.file.buffer, req.file.mimetype || 'application/octet-stream');
      const record = await insertFileRecord({
        ownerId: req.user.id, originalName: req.file.originalname, storagePath,
        mimeType: req.file.mimetype || 'application/octet-stream', sizeBytes: req.file.size, isPublic, accessMode,
        title: req.body.title, description: req.body.description, teamId
      });
      res.status(201).json({ id: record.id });
    } catch (e) {
      // Surface the real Supabase error to the response (not just the server
      // log) — "could not save to storage" alone hides whether this is a
      // missing bucket, a missing/misnamed SUPABASE_URL/SUPABASE_SERVICE_KEY,
      // or a Storage permission problem, all of which need a different fix.
      console.error('[files/upload] storage error:', e);
      const detail = e && e.message ? e.message : String(e);
      res.status(500).json({ error: `Upload failed — could not save to storage (${detail})` });
    }
  });
});

router.get('/mine', async (req, res) => {
  try {
    const files = await listFilesForOwner(req.user.id);
    const limit = req.user.max_files == null ? 10 : req.user.max_files;
    res.json({ files, limit, used: files.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load your files' });
  }
});

router.get('/public', async (req, res) => {
  try {
    res.json({ files: await listPublicFiles(req.user.id) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load public files' });
  }
});

// GET /api/files/:id/download — owner, admin, any signed-in user (if public
// and open), or a signed-in user with an approved request (if public and
// restricted/"protected"). Redirects to a short-lived signed Storage URL
// rather than streaming the file through this function.
router.get('/:id/download', async (req, res) => {
  try {
    const file = await getFileById(req.params.id);
    if (!file) return res.status(404).json({ error: 'File not found' });
    const isOwner = file.owner_id === req.user.id;
    const isAdmin = req.user.role === 'admin';
    if (!isOwner && !isAdmin) {
      if (file.team_id) {
        const isTeamMember = await isAcceptedTeamMember(file.team_id, req.user.id);
        if (isTeamMember) {
          const url = await getFileSignedUrl(file.storage_path);
          return res.redirect(url);
        }
      }
      if (!file.is_public) {
        return res.status(403).json({ error: 'This file is private' });
      }
      if (file.access_mode === 'restricted') {
        const approved = await hasApprovedAccess(file.id, req.user.id);
        if (!approved) {
          return res.status(403).json({ error: 'This file is protected — request access from Public Files first.' });
        }
      }
    }
    const url = await getFileSignedUrl(file.storage_path);
    res.redirect(url);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not generate download link' });
  }
});

// POST /api/files/:id/request-access — signed-in, non-owner user asks the
// owner of a "protected" public file for permission. Pops a message toast
// to the owner the same way admin→user messages do.
router.post('/:id/request-access', blockIfSuspended, async (req, res) => {
  try {
    const file = await getFileById(req.params.id);
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (file.owner_id === req.user.id) return res.status(400).json({ error: "It's your own file — just open it." });
    if (!file.is_public || file.access_mode !== 'restricted') {
      return res.status(400).json({ error: 'This file does not require a request.' });
    }
    await requestFileAccess(file.id, req.user.id);
    const label = file.title || file.original_name;
    insertMessage({
      recipientId: file.owner_id, senderId: req.user.id,
      body: `${req.user.email} requested access to your protected file "${label}". Review it from My Files.`
    }).catch(() => {}); // a missed notification toast isn't worth failing the request over
    res.status(201).json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not send request' });
  }
});

// GET /api/files/access-requests — every request (pending/approved/denied)
// aimed at files I own, newest first. Powers the "people asking to see your
// protected files" panel on My Files.
router.get('/access-requests', async (req, res) => {
  try {
    res.json({ requests: await listIncomingAccessRequests(req.user.id) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load access requests' });
  }
});

// POST /api/files/access-requests/:id/decide  { approve: boolean }
router.post('/access-requests/:id/decide', blockIfSuspended, async (req, res) => {
  try {
    const approve = !!(req.body && req.body.approve);
    const result = await decideAccessRequest(req.params.id, req.user.id, approve);
    if (!result) return res.status(404).json({ error: 'Request not found' });
    insertMessage({
      recipientId: result.requesterId, senderId: req.user.id,
      body: approve ? 'Your request to view a protected file was approved — you can open it from Public Files now.'
                    : 'Your request to view a protected file was declined.'
    }).catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not decide on request' });
  }
});

// PATCH /api/files/:id  { isPublic?, title?, description? } — owner or admin
router.patch('/:id', blockIfSuspended, async (req, res) => {
  try {
    const file = await getFileById(req.params.id);
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (file.owner_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not your file' });
    }
    if (req.body.isPublic !== undefined) {
      await updateFilePublic(file.id, !!req.body.isPublic);
    }
    if (req.body.teamId !== undefined) {
      if (req.body.teamId) {
        const isMember = await isAcceptedTeamMember(req.body.teamId, req.user.id);
        if (!isMember) return res.status(403).json({ error: 'You are not an accepted member of that team.' });
      }
      await updateFileTeam(file.id, req.body.teamId || null);
    }
    if (req.body.accessMode !== undefined) {
      await updateFileAccessMode(file.id, req.body.accessMode);
    }
    if (req.body.title !== undefined || req.body.description !== undefined) {
      if (req.body.title !== undefined && String(req.body.title).length > 200) {
        return res.status(400).json({ error: 'Title is too long (200 characters max).' });
      }
      if (req.body.description !== undefined && String(req.body.description).length > 2000) {
        return res.status(400).json({ error: 'Description is too long (2000 characters max).' });
      }
      await updateFileDetails(file.id, { title: req.body.title, description: req.body.description });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not update file' });
  }
});

// DELETE /api/files/:id — owner or admin (admins use this to remove any
// user's document, e.g. from the admin dashboard's file list).
router.delete('/:id', async (req, res) => {
  try {
    const file = await getFileById(req.params.id);
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (file.owner_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not your file' });
    }
    await deleteFileRecord(file.id, file.storage_path);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not delete file' });
  }
});

module.exports = router;
