const express = require('express');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const {
  insertFileRecord, getFileById, listFilesForOwner, listPublicFiles,
  updateFilePublic, updateFileDetails, updateFileAccessMode, deleteFileRecord, uploadFileToStorage, getFileSignedUrl, countFilesForOwner,
  requestFileAccess, listIncomingAccessRequests, decideAccessRequest, hasApprovedAccess, insertMessage,
  isAcceptedTeamMember, updateFileTeam,
  createFileShareCode, createBundleShareCode, listMyShareCodes, listShareCodesForFile, revokeShareCode, redeemFileShareCode, hasShareAccess,
  hasAccountShareAccess,
  listFilesSharedWithUser, listAdminIds
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
        const sharedWithMe = await hasShareAccess(file.id, req.user.id);
        const accountShared = sharedWithMe ? false : await hasAccountShareAccess(file.owner_id, req.user.id);
        if (!sharedWithMe && !accountShared) return res.status(403).json({ error: 'This file is private' });
        const url = await getFileSignedUrl(file.storage_path);
        return res.redirect(url);
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

// GET /api/files/shared-with-me — files I got access to by redeeming a
// code, whether or not they're otherwise public.
router.get('/shared-with-me', async (req, res) => {
  try {
    res.json({ files: await listFilesSharedWithUser(req.user.id) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load shared files' });
  }
});

// Shared validation for the "how long should this code last" input, used
// by both the single-file and bundle share routes. Returns an ISO string
// or null (never expires) — throws a descriptive Error on bad input.
function parseExpiresInHours(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) throw new Error('expiresInHours must be a positive number of hours, if provided.');
  return new Date(Date.now() + hours * 3600 * 1000).toISOString();
}

// POST /api/files/:id/share  { maxUses?, expiresInHours? } — owner or admin
// only. Creates a short code (and, client-side, a QR code encoding a link
// with it) that grants this one private file to whoever redeems it via
// /api/files/redeem, without making the file public. expiresInHours is
// optional — omit it for a code that never expires on its own.
router.post('/:id/share', blockIfSuspended, async (req, res) => {
  try {
    const file = await getFileById(req.params.id);
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (file.owner_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not your file' });
    }
    const maxUses = req.body && req.body.maxUses ? Number(req.body.maxUses) : null;
    if (maxUses != null && (!Number.isInteger(maxUses) || maxUses < 1)) {
      return res.status(400).json({ error: 'maxUses must be a whole number, 1 or greater, if provided.' });
    }
    let expiresAt;
    try { expiresAt = parseExpiresInHours(req.body && req.body.expiresInHours); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    const share = await createFileShareCode(file.id, req.user.id, maxUses, expiresAt);
    res.status(201).json({ code: share.code, maxUses: share.max_uses, expiresAt: share.expires_at });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Could not create a share code' });
  }
});

// POST /api/files/share-codes/bundle  { fileIds: [...], maxUses?, expiresInHours? }
// — one code/QR that unlocks several of the caller's own files at once.
// Every id in fileIds must belong to the caller (or the caller must be
// admin) — same ownership rule as the single-file share route.
router.post('/share-codes/bundle', blockIfSuspended, async (req, res) => {
  const fileIds = Array.isArray(req.body && req.body.fileIds) ? req.body.fileIds.map(Number).filter(Number.isInteger) : [];
  if (fileIds.length < 2) return res.status(400).json({ error: 'Pick at least 2 files to bundle — for one file, use its own Share button instead.' });
  try {
    for (const id of fileIds) {
      const file = await getFileById(id);
      if (!file) return res.status(404).json({ error: 'One of the selected files no longer exists.' });
      if (file.owner_id !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'You can only bundle files you own.' });
      }
    }
    const maxUses = req.body && req.body.maxUses ? Number(req.body.maxUses) : null;
    if (maxUses != null && (!Number.isInteger(maxUses) || maxUses < 1)) {
      return res.status(400).json({ error: 'maxUses must be a whole number, 1 or greater, if provided.' });
    }
    let expiresAt;
    try { expiresAt = parseExpiresInHours(req.body && req.body.expiresInHours); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    const share = await createBundleShareCode(fileIds, req.user.id, maxUses, expiresAt);
    res.status(201).json({ code: share.code, maxUses: share.max_uses, expiresAt: share.expires_at, fileCount: fileIds.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Could not create a bundle share code' });
  }
});

// GET /api/files/share-codes/mine — every code (single-file or bundle) the
// caller has created, for a management view (see what's active/expired,
// revoke anything no longer wanted).
router.get('/share-codes/mine', async (req, res) => {
  try {
    res.json({ codes: await listMyShareCodes(req.user.id) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load your share codes' });
  }
});

// GET /api/files/:id/share  — owner or admin: list this file's active/used
// share codes, to show alongside the QR code or revoke one.
router.get('/:id/share', async (req, res) => {
  try {
    const file = await getFileById(req.params.id);
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (file.owner_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not your file' });
    }
    res.json({ codes: await listShareCodesForFile(file.id) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load share codes' });
  }
});

// DELETE /api/files/share/:shareId — owner or admin: turn off a code so it
// can no longer be redeemed (people who already redeemed it keep access).
router.delete('/share/:shareId', blockIfSuspended, async (req, res) => {
  try {
    await revokeShareCode(req.params.shareId);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not revoke share code' });
  }
});

// POST /api/files/redeem  { code } — any signed-in user, e.g. from scanning
// a QR code or typing the code in by hand. Grants standing access to every
// file that code covers (one for a normal code, several for a bundle), and
// notifies the file owner(s) plus every admin (same toast system
// admin→user messages use).
router.post('/redeem', blockIfSuspended, async (req, res) => {
  const code = (req.body && req.body.code ? String(req.body.code) : '').trim();
  if (!code) return res.status(400).json({ error: 'Enter or scan a code first.' });
  try {
    const result = await redeemFileShareCode(code, req.user.id);
    if (!result.alreadyHadAccess) {
      const notifyIds = new Set(await listAdminIds());
      notifyIds.add(result.ownerId);
      notifyIds.delete(req.user.id);
      const names = result.files.map(f => f.title).join(', ');
      const body = result.files.length > 1
        ? `${req.user.email} accessed ${result.files.length} files (${names}) using a share code.`
        : `${req.user.email} accessed "${names}" using a share code.`;
      notifyIds.forEach(id => insertMessage({ recipientId: id, senderId: req.user.id, body }).catch(() => {}));
    }
    res.json({ ok: true, files: result.files });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Could not redeem that code' });
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
