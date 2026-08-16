// db.js — Supabase (Postgres + Storage) data layer.
//
// Replaces the old better-sqlite3 + local-disk version. Run supabase/schema.sql
// once in the Supabase SQL Editor before starting the server, and create a
// Storage bucket named "documents" (Storage → New bucket → name it exactly
// "documents", keep it Private) before using file uploads.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.warn('[warn] SUPABASE_URL / SUPABASE_SERVICE_KEY are not set — the app cannot reach the database.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false }
});

const FILES_BUCKET = 'documents';

/* ---------------- users ---------------- */

async function getUserByEmail(email) {
  const { data, error } = await supabase.from('users').select('*').eq('email', email).maybeSingle();
  if (error) throw error;
  return data;
}

async function getUserById(id) {
  const { data, error } = await supabase
    .from('users')
    .select('id, email, name, phone, instagram_url, tiktok_url, role, suspended, max_files')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function insertUser({ email, passwordHash, name, role }) {
  const { data, error } = await supabase
    .from('users')
    .insert({ email, password_hash: passwordHash, name, role })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function listUsers() {
  const { data, error } = await supabase
    .from('users')
    .select('id, email, name, role, suspended, max_files, created_at')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

async function updateUserMaxFiles(id, maxFiles) {
  const { data, error } = await supabase.from('users').update({ max_files: maxFiles }).eq('id', id).select();
  if (error) throw error;
  return data && data[0];
}

async function countFilesForOwner(ownerId) {
  const { count, error } = await supabase
    .from('files').select('id', { count: 'exact', head: true }).eq('owner_id', ownerId);
  if (error) throw error;
  return count || 0;
}

async function updateUserRole(id, role) {
  const { data, error } = await supabase.from('users').update({ role }).eq('id', id).select();
  if (error) throw error;
  return data && data[0];
}

// Suspended accounts can still log in (so they see a clear "your account is
// paused" message) but every write action — saving progress, uploading or
// posting files — is blocked. See middleware/auth.js and routes/kv.js / files.js.
async function setUserSuspended(id, suspended) {
  const { data, error } = await supabase.from('users').update({ suspended: !!suspended }).eq('id', id).select();
  if (error) throw error;
  return data && data[0];
}

async function updateUserPassword(id, passwordHash) {
  const { data, error } = await supabase.from('users').update({ password_hash: passwordHash }).eq('id', id).select();
  if (error) throw error;
  return data && data[0];
}

// A user editing their own "account center" — name, phone, and social links.
// Every field is optional; pass only what changed (undefined fields are left
// untouched rather than overwritten with null).
async function updateUserProfile(id, { name, phone, instagramUrl, tiktokUrl }) {
  const patch = {};
  if (name !== undefined) patch.name = name;
  if (phone !== undefined) patch.phone = phone;
  if (instagramUrl !== undefined) patch.instagram_url = instagramUrl;
  if (tiktokUrl !== undefined) patch.tiktok_url = tiktokUrl;
  const { data, error } = await supabase
    .from('users').update(patch).eq('id', id)
    .select('id, email, name, phone, instagram_url, tiktok_url, role');
  if (error) throw error;
  return data && data[0];
}

// The subset of a profile that's safe to show to anyone who clicks an
// author's name from Public Files — no password hash, no raw email.
async function getPublicProfile(id) {
  const { data, error } = await supabase
    .from('users')
    .select('id, name, phone, instagram_url, tiktok_url')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Deletes the account, all their kv rows, and all their files (both the
// database rows and the actual files in Storage). users.id → files.owner_id
// has ON DELETE CASCADE, so we only need to manually clean up Storage itself.
async function deleteUser(id) {
  const { data: userFiles, error: filesErr } = await supabase.from('files').select('storage_path').eq('owner_id', id);
  if (filesErr) throw filesErr;
  if (userFiles && userFiles.length) {
    await supabase.storage.from(FILES_BUCKET).remove(userFiles.map(f => f.storage_path));
  }
  const { error } = await supabase.from('users').delete().eq('id', id);
  if (error) throw error;
}

/* ---------------- kv (generic key/value store) ---------------- */

async function kvGet(scopeUserId, app, key) {
  const { data, error } = await supabase
    .from('kv').select('value').eq('scope_user_id', scopeUserId).eq('app', app).eq('key', key).maybeSingle();
  if (error) throw error;
  return data ? data.value : null;
}

async function kvSet(scopeUserId, app, key, value) {
  const { error } = await supabase.from('kv').upsert(
    { scope_user_id: scopeUserId, app, key, value, updated_at: new Date().toISOString() },
    { onConflict: 'scope_user_id,app,key' }
  );
  if (error) throw error;
}

async function kvDelete(scopeUserId, app, key) {
  const { error } = await supabase.from('kv').delete().eq('scope_user_id', scopeUserId).eq('app', app).eq('key', key);
  if (error) throw error;
}

async function kvList(scopeUserId, app, prefix) {
  const { data, error } = await supabase
    .from('kv').select('key').eq('scope_user_id', scopeUserId).eq('app', app).like('key', `${prefix}%`).order('key', { ascending: true });
  if (error) throw error;
  return data.map(r => r.key);
}

async function kvCountByPrefix(app, prefix) {
  const { data, error } = await supabase
    .from('kv').select('scope_user_id').neq('scope_user_id', 0).eq('app', app).like('key', `${prefix}%`);
  if (error) throw error;
  const counts = {};
  data.forEach(row => { counts[row.scope_user_id] = (counts[row.scope_user_id] || 0) + 1; });
  return counts;
}

async function kvRowsForAppKey(app, key) {
  const { data, error } = await supabase
    .from('kv').select('scope_user_id, value').neq('scope_user_id', 0).eq('app', app).eq('key', key);
  if (error) throw error;
  return data;
}

// Deletes every kv row (progress) for a user in one app, or every app if
// appFilter is omitted. Used by the admin "delete this user's documents /
// progress" action without deleting the account itself.
async function kvDeleteAllForUser(scopeUserId, appFilter) {
  let query = supabase.from('kv').delete().eq('scope_user_id', scopeUserId);
  if (appFilter) query = query.eq('app', appFilter);
  const { error } = await query;
  if (error) throw error;
}

/* ---------------- files (Supabase Storage) ---------------- */

async function insertFileRecord({ ownerId, originalName, storagePath, mimeType, sizeBytes, isPublic, accessMode, title, description, teamId }) {
  const { data, error } = await supabase
    .from('files')
    .insert({
      owner_id: ownerId, original_name: originalName, storage_path: storagePath, mime_type: mimeType,
      size_bytes: sizeBytes, is_public: !!isPublic,
      access_mode: accessMode === 'restricted' ? 'restricted' : 'open',
      title: title ? String(title).trim().slice(0, 200) : null,
      description: description ? String(description).trim().slice(0, 2000) : null,
      team_id: teamId || null
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Owner or admin editing a file's title/description after upload.
async function updateFileDetails(id, { title, description }) {
  const patch = {};
  if (title !== undefined) patch.title = title ? String(title).trim().slice(0, 200) : null;
  if (description !== undefined) patch.description = description ? String(description).trim().slice(0, 2000) : null;
  const { data, error } = await supabase.from('files').update(patch).eq('id', id).select();
  if (error) throw error;
  return data && data[0];
}

// Owner or admin flipping a public file between "anyone signed in can open"
// and "must request my permission first." Only meaningful while is_public is
// true; harmless (just unused) if the file is later made private again.
async function updateFileAccessMode(id, accessMode) {
  const mode = accessMode === 'restricted' ? 'restricted' : 'open';
  const { error } = await supabase.from('files').update({ access_mode: mode }).eq('id', id);
  if (error) throw error;
}

async function getFileById(id) {
  const { data, error } = await supabase.from('files').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

async function listFilesForOwner(ownerId) {
  const { data, error } = await supabase
    .from('files').select('id, original_name, title, description, mime_type, size_bytes, is_public, team_id, teams(name), created_at')
    .eq('owner_id', ownerId).order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(f => ({ ...f, team_name: f.teams ? f.teams.name : null, teams: undefined }));
}

// viewerId is used only to attach that viewer's own request status
// ('pending' | 'approved' | 'denied' | null) to each restricted file, so the
// frontend can show "Open" / "Request pending" / "Request access" per row.
async function listPublicFiles(viewerId) {
  const { data, error } = await supabase
    .from('files')
    .select('id, original_name, title, description, mime_type, size_bytes, created_at, owner_id, access_mode, users!files_owner_id_fkey(email, name)')
    .eq('is_public', true)
    .order('created_at', { ascending: false });
  if (error) throw error;

  let statusByFileId = {};
  if (viewerId) {
    const { data: reqs, error: reqErr } = await supabase
      .from('file_access_requests').select('file_id, status').eq('requester_id', viewerId);
    if (reqErr) throw reqErr;
    (reqs || []).forEach(r => { statusByFileId[r.file_id] = r.status; });
  }

  return (data || []).map(f => ({
    id: f.id, original_name: f.original_name, title: f.title, description: f.description,
    mime_type: f.mime_type, size_bytes: f.size_bytes, created_at: f.created_at, owner_id: f.owner_id,
    access_mode: f.access_mode,
    my_request_status: f.access_mode === 'restricted' ? (statusByFileId[f.id] || null) : null,
    uploader_email: f.users ? f.users.email : null, uploader_name: f.users ? f.users.name : null
  }));
}

// Every file any user has ever uploaded — used by the admin dashboard so an
// admin can find and delete a specific user's documents.
async function listAllFiles() {
  const { data, error } = await supabase
    .from('files')
    .select('id, original_name, mime_type, size_bytes, is_public, access_mode, created_at, owner_id, users!files_owner_id_fkey(email, name)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(f => ({
    id: f.id, original_name: f.original_name, mime_type: f.mime_type, size_bytes: f.size_bytes,
    is_public: f.is_public, access_mode: f.access_mode, created_at: f.created_at, owner_id: f.owner_id,
    owner_email: f.users ? f.users.email : null, owner_name: f.users ? f.users.name : null
  }));
}

async function updateFilePublic(id, isPublic) {
  const { error } = await supabase.from('files').update({ is_public: !!isPublic }).eq('id', id);
  if (error) throw error;
}

/* ---------------- file access requests (protected public files) ---------------- */

// Creates a pending request, or — if the requester already has a row for
// this file (e.g. they were denied before) — flips it back to pending.
async function requestFileAccess(fileId, requesterId) {
  const { data, error } = await supabase
    .from('file_access_requests')
    .upsert(
      { file_id: fileId, requester_id: requesterId, status: 'pending', decided_at: null },
      { onConflict: 'file_id,requester_id' }
    )
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Every pending/approved/denied request aimed at files owned by ownerId —
// powers the "people asking to see your protected files" panel on My Files.
async function listIncomingAccessRequests(ownerId) {
  const { data, error } = await supabase
    .from('file_access_requests')
    .select('id, file_id, status, created_at, files!inner(id, title, original_name, owner_id), users!file_access_requests_requester_id_fkey(id, email, name)')
    .eq('files.owner_id', ownerId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(r => ({
    id: r.id, file_id: r.file_id, status: r.status, created_at: r.created_at,
    file_title: r.files ? (r.files.title || r.files.original_name) : null,
    requester_id: r.users ? r.users.id : null,
    requester_email: r.users ? r.users.email : null,
    requester_name: r.users ? r.users.name : null
  }));
}

// Approves or denies a request. Verifies the file really belongs to
// ownerId first so a user can't decide on someone else's incoming requests.
async function decideAccessRequest(requestId, ownerId, approve) {
  const { data: reqRow, error: reqErr } = await supabase
    .from('file_access_requests')
    .select('id, file_id, requester_id, files!inner(owner_id)')
    .eq('id', requestId)
    .maybeSingle();
  if (reqErr) throw reqErr;
  if (!reqRow || !reqRow.files || reqRow.files.owner_id !== ownerId) return null;

  const { error } = await supabase
    .from('file_access_requests')
    .update({ status: approve ? 'approved' : 'denied', decided_at: new Date().toISOString() })
    .eq('id', requestId);
  if (error) throw error;
  return { fileId: reqRow.file_id, requesterId: reqRow.requester_id };
}

async function hasApprovedAccess(fileId, userId) {
  const { data, error } = await supabase
    .from('file_access_requests').select('status').eq('file_id', fileId).eq('requester_id', userId).maybeSingle();
  if (error) throw error;
  return !!(data && data.status === 'approved');
}

async function deleteFileRecord(id, storagePath) {
  await supabase.storage.from(FILES_BUCKET).remove([storagePath]);
  const { error } = await supabase.from('files').delete().eq('id', id);
  if (error) throw error;
}

async function uploadFileToStorage(storagePath, buffer, mimeType) {
  const { error } = await supabase.storage.from(FILES_BUCKET).upload(storagePath, buffer, { contentType: mimeType, upsert: false });
  if (error) throw error;
}

// Signed URL, expires in 5 minutes — used instead of a permanently public
// link, so private files stay actually private even though Storage buckets
// are otherwise all-or-nothing.
async function getFileSignedUrl(storagePath) {
  const { data, error } = await supabase.storage.from(FILES_BUCKET).createSignedUrl(storagePath, 300);
  if (error) throw error;
  return data.signedUrl;
}

/* ---------------- teams (shared-file groups) ---------------- */

// Creates a team and auto-adds the creator as an 'accepted' member —
// they never have to invite/accept themselves.
async function createTeam(ownerId, name) {
  const { data: team, error } = await supabase
    .from('teams').insert({ name, owner_id: ownerId }).select().single();
  if (error) throw error;
  const { error: memErr } = await supabase
    .from('team_members').insert({ team_id: team.id, user_id: ownerId, status: 'accepted', invited_by: ownerId, responded_at: new Date().toISOString() });
  if (memErr) throw memErr;
  return team;
}

// Every team the user owns or is a member of (any status), with their own
// membership status attached — powers "My Teams" and "Invitations" on the UI.
async function listTeamsForUser(userId) {
  const { data, error } = await supabase
    .from('team_members')
    .select('status, created_at, teams!inner(id, name, owner_id, created_at)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(r => ({
    id: r.teams.id, name: r.teams.name, owner_id: r.teams.owner_id,
    created_at: r.teams.created_at, my_status: r.status
  }));
}

async function getTeamById(id) {
  const { data, error } = await supabase.from('teams').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

// All members of a team (any status) with name/email, newest invite first —
// shown to the owner so they can see who's accepted / still pending.
async function listTeamMembers(teamId) {
  const { data, error } = await supabase
    .from('team_members')
    .select('id, user_id, status, created_at, responded_at, users!team_members_user_id_fkey(id, name, email)')
    .eq('team_id', teamId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []).map(m => ({
    id: m.id, user_id: m.user_id, status: m.status, created_at: m.created_at, responded_at: m.responded_at,
    name: m.users ? m.users.name : null, email: m.users ? m.users.email : null
  }));
}

// True only if userId has an 'accepted' row for teamId — the actual access
// check used when someone tries to download a team-shared file.
async function isAcceptedTeamMember(teamId, userId) {
  const { data, error } = await supabase
    .from('team_members').select('status').eq('team_id', teamId).eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return !!(data && data.status === 'accepted');
}

// Owner-only: search other users by name/email to invite. Excludes the
// owner themself and anyone already invited (any status) to this team.
async function searchInvitableUsers(teamId, ownerId, query) {
  const { data: existing, error: exErr } = await supabase
    .from('team_members').select('user_id').eq('team_id', teamId);
  if (exErr) throw exErr;
  const excludeIds = new Set([ownerId, ...((existing || []).map(r => r.user_id))]);

  const { data, error } = await supabase
    .from('users').select('id, name, email')
    .or(`name.ilike.%${query}%,email.ilike.%${query}%`)
    .limit(15);
  if (error) throw error;
  return (data || []).filter(u => !excludeIds.has(u.id));
}

// Inserts a pending invite, or — if that user already has a 'declined' row
// from before — flips it back to pending so the owner can re-invite them.
async function inviteToTeam(teamId, userId, invitedBy) {
  const { data, error } = await supabase
    .from('team_members')
    .upsert(
      { team_id: teamId, user_id: userId, status: 'pending', invited_by: invitedBy, responded_at: null },
      { onConflict: 'team_id,user_id' }
    )
    .select().single();
  if (error) throw error;
  return data;
}

// The invited user accepting/declining their own invite. Scoped to
// user_id so nobody can respond on someone else's behalf.
async function respondToTeamInvite(teamId, userId, accept) {
  const { data, error } = await supabase
    .from('team_members')
    .update({ status: accept ? 'accepted' : 'declined', responded_at: new Date().toISOString() })
    .eq('team_id', teamId).eq('user_id', userId).eq('status', 'pending')
    .select().maybeSingle();
  if (error) throw error;
  return data;
}

// Owner removing a member (or revoking a still-pending invite) — deletes
// the row outright, freeing up that (team_id, user_id) pair to be re-invited.
async function removeTeamMember(teamId, userId) {
  const { error } = await supabase.from('team_members').delete().eq('team_id', teamId).eq('user_id', userId);
  if (error) throw error;
}

// Files shared with any team the user is an 'accepted' member of (their
// own uploads or teammates'), for the "Team Files" list.
async function listFilesForUserTeams(userId) {
  const { data: memberships, error: memErr } = await supabase
    .from('team_members').select('team_id').eq('user_id', userId).eq('status', 'accepted');
  if (memErr) throw memErr;
  const teamIds = (memberships || []).map(m => m.team_id);
  if (!teamIds.length) return [];

  const { data, error } = await supabase
    .from('files')
    .select('id, original_name, title, description, mime_type, size_bytes, created_at, owner_id, team_id, teams!inner(name), users!files_owner_id_fkey(email, name)')
    .in('team_id', teamIds)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(f => ({
    id: f.id, original_name: f.original_name, title: f.title, description: f.description,
    mime_type: f.mime_type, size_bytes: f.size_bytes, created_at: f.created_at, owner_id: f.owner_id,
    team_id: f.team_id, team_name: f.teams ? f.teams.name : null,
    uploader_email: f.users ? f.users.email : null, uploader_name: f.users ? f.users.name : null
  }));
}

// Owner setting/clearing which of their own teams a file is shared with.
async function updateFileTeam(id, teamId) {
  const { error } = await supabase.from('files').update({ team_id: teamId || null }).eq('id', id);
  if (error) throw error;
}

/* ---------------- books & questions (facilitator-managed exercises) ---------------- */

async function createBook({ title, author, description, createdBy }) {
  const { data, error } = await supabase
    .from('books').insert({ title, author: author || null, description: description || null, created_by: createdBy })
    .select().single();
  if (error) throw error;
  return data;
}

async function listBooks() {
  const { data, error } = await supabase.from('books').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

async function getBookById(id) {
  const { data, error } = await supabase.from('books').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

async function updateBook(id, { title, author, description }) {
  const patch = {};
  if (title !== undefined) patch.title = title;
  if (author !== undefined) patch.author = author;
  if (description !== undefined) patch.description = description;
  const { data, error } = await supabase.from('books').update(patch).eq('id', id).select();
  if (error) throw error;
  return data && data[0];
}

// Admin-only in the route layer — deletes the book and, via ON DELETE
// CASCADE, every question that belonged to it.
async function deleteBook(id) {
  const { error } = await supabase.from('books').delete().eq('id', id);
  if (error) throw error;
}

async function createQuestion({ bookId, questionText, options, correctOptionId, explanation, reference, color, createdBy }) {
  const { data, error } = await supabase
    .from('questions')
    .insert({
      book_id: bookId || null, question_text: questionText, options,
      correct_option_id: correctOptionId, explanation: explanation || null,
      reference: reference || null, color: color || '#2F6F4F', created_by: createdBy
    })
    .select().single();
  if (error) throw error;
  return data;
}

// includeAnswer=true (facilitator/admin managing content) returns everything
// including correct_option_id/explanation. includeAnswer=false (a learner
// doing the exercise) strips those so the answer can't be read from the
// network response before they check it.
async function listQuestionsForBook(bookId, includeAnswer) {
  const cols = includeAnswer
    ? '*'
    : 'id, book_id, question_text, options, created_at';
  const { data, error } = await supabase.from('questions').select(cols).eq('book_id', bookId).order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

async function getQuestionById(id) {
  const { data, error } = await supabase.from('questions').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

async function updateQuestion(id, { questionText, options, correctOptionId, explanation, reference, color }) {
  const patch = { updated_at: new Date().toISOString() };
  if (questionText !== undefined) patch.question_text = questionText;
  if (options !== undefined) patch.options = options;
  if (correctOptionId !== undefined) patch.correct_option_id = correctOptionId;
  if (explanation !== undefined) patch.explanation = explanation;
  if (reference !== undefined) patch.reference = reference;
  if (color !== undefined) patch.color = color;
  const { data, error } = await supabase.from('questions').update(patch).eq('id', id).select();
  if (error) throw error;
  return data && data[0];
}

async function deleteQuestion(id) {
  const { error } = await supabase.from('questions').delete().eq('id', id);
  if (error) throw error;
}

/* ---------------- messages (admin → user popup notifications) ---------------- */

async function insertMessage({ recipientId, senderId, body }) {
  const { data, error } = await supabase
    .from('messages').insert({ recipient_id: recipientId, sender_id: senderId, body }).select().single();
  if (error) throw error;
  return data;
}

async function listUnreadMessagesForUser(userId) {
  const { data, error } = await supabase
    .from('messages').select('id, body, created_at').eq('recipient_id', userId).is('read_at', null).order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

async function markMessageRead(id, userId) {
  // Scoped to recipient_id so a user can only mark their own messages read.
  const { error } = await supabase.from('messages').update({ read_at: new Date().toISOString() }).eq('id', id).eq('recipient_id', userId);
  if (error) throw error;
}

module.exports = {
  supabase,
  getUserByEmail, getUserById, insertUser, listUsers, updateUserRole,
  setUserSuspended, updateUserPassword, deleteUser, updateUserMaxFiles, countFilesForOwner,
  updateUserProfile, getPublicProfile,
  kvGet, kvSet, kvDelete, kvList, kvCountByPrefix, kvRowsForAppKey, kvDeleteAllForUser,
  insertFileRecord, getFileById, listFilesForOwner, listPublicFiles, listAllFiles,
  updateFilePublic, updateFileDetails, updateFileAccessMode, deleteFileRecord, uploadFileToStorage, getFileSignedUrl,
  requestFileAccess, listIncomingAccessRequests, decideAccessRequest, hasApprovedAccess,
  createTeam, listTeamsForUser, getTeamById, listTeamMembers, isAcceptedTeamMember,
  searchInvitableUsers, inviteToTeam, respondToTeamInvite, removeTeamMember, listFilesForUserTeams, updateFileTeam,
  createBook, listBooks, getBookById, updateBook, deleteBook,
  createQuestion, listQuestionsForBook, getQuestionById, updateQuestion, deleteQuestion,
  insertMessage, listUnreadMessagesForUser, markMessageRead
};
