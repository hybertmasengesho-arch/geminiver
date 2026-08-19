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

// Same combined-activity ranking the admin Ranking tab shows (total days/
// questions completed across Matrix, Reasoning Lab, and 30-Day Prep),
// computed once here so both the admin bulk "share ranks" action and each
// learner's own rank lookup (courses.html's badge) agree on one number.
async function getOverallRanking() {
  const users = await listUsers();
  const matrixByUser = await kvCountByPrefix('matrix', 'day-progress:');

  const reasoningRows = await kvRowsForAppKey('reasoning', 'progress');
  const reasoningByUser = {};
  reasoningRows.forEach(r => {
    try { reasoningByUser[r.scope_user_id] = Object.values(JSON.parse(r.value)).filter(d => d && d.done).length; }
    catch (e) { reasoningByUser[r.scope_user_id] = 0; }
  });

  const prep30Rows = await kvRowsForAppKey('prep30', 'prep30-progress');
  const prep30ByUser = {};
  prep30Rows.forEach(r => {
    try { const p = JSON.parse(r.value); prep30ByUser[r.scope_user_id] = Array.isArray(p.completed) ? p.completed.length : 0; }
    catch (e) { prep30ByUser[r.scope_user_id] = 0; }
  });

  const ranked = users.map(u => {
    const matrix = matrixByUser[u.id] || 0;
    const reasoning = reasoningByUser[u.id] || 0;
    const prep30 = prep30ByUser[u.id] || 0;
    return { id: u.id, email: u.email, name: u.name, matrix, reasoning, prep30, total: matrix + reasoning + prep30 };
  });
  ranked.sort((a, b) => b.total - a.total);
  ranked.forEach((r, i) => { r.rank = i + 1; });
  return ranked;
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
  if (error) {
    // The #1 cause of this in a fresh deploy: the "documents" Storage
    // bucket was never created in the Supabase dashboard (see the note at
    // the top of this file). Surface that plainly instead of a bare
    // "Bucket not found" that doesn't say what to do about it.
    if (/bucket not found/i.test(error.message || '')) {
      throw new Error('Storage bucket "documents" does not exist yet — in Supabase go to Storage → New bucket, name it exactly "documents", and keep it Private.');
    }
    throw error;
  }
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

// Deletes the team itself. team_members rows cascade via the FK
// (on delete cascade), and any file previously shared with this team has
// its team_id cleared by the files.team_id FK's on delete set null —
// the files themselves are untouched, they just stop being team-shared.
async function deleteTeam(teamId) {
  const { error } = await supabase.from('teams').delete().eq('id', teamId);
  if (error) throw error;
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

/* ---------------- team join codes / QR ---------------- */
// Same shape as file/account share codes, but redeeming one joins the
// team directly (an 'accepted' team_members row) instead of granting file
// access. Each minted code is only good for 3 days if unused — see the
// expiry check in redeemTeamJoinCode — but that clock doesn't apply
// retroactively to anyone who already joined through it.

const TEAM_JOIN_CODE_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

async function createTeamJoinCode(teamId, createdBy) {
  const expiresAt = new Date(Date.now() + TEAM_JOIN_CODE_TTL_MS).toISOString();
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomShareCode();
    const { data, error } = await supabase
      .from('team_join_codes')
      .insert({ team_id: teamId, code, created_by: createdBy, expires_at: expiresAt })
      .select()
      .maybeSingle();
    if (!error) return data;
    if (error.code !== '23505') throw error;
  }
  throw new Error('Could not generate a unique join code — try again.');
}

// The team's current active, unexpired code, if any — so the owner's panel
// can reuse one QR instead of minting a new one on every visit.
async function getActiveTeamJoinCode(teamId) {
  const { data, error } = await supabase
    .from('team_join_codes')
    .select('id, code, active, expires_at, created_at')
    .eq('team_id', teamId).eq('active', true)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data;
}

async function revokeTeamJoinCode(id, teamId) {
  const { error } = await supabase.from('team_join_codes').update({ active: false }).eq('id', id).eq('team_id', teamId);
  if (error) throw error;
}

async function getTeamJoinCodeByCode(code) {
  const { data, error } = await supabase
    .from('team_join_codes')
    .select('id, team_id, active, expires_at, teams!inner(id, name, owner_id)')
    .eq('code', code.toUpperCase())
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Validates the code (active + not past its 3-day expiry) and joins the
// redeemer to the team as an 'accepted' member outright — no invite/accept
// round trip. Subject to the same MAX_TEAM_SIZE cap the invite path uses
// (enforced in routes/teams.js, same as inviteToTeam).
async function redeemTeamJoinCode(code, userId) {
  const share = await getTeamJoinCodeByCode(code);
  if (!share || !share.active) throw new Error('That code is invalid or has been turned off.');
  if (new Date(share.expires_at).getTime() < Date.now()) {
    throw new Error('That code has expired — ask the team owner for a new one.');
  }
  if (share.teams.owner_id === userId) throw new Error("That's your own team — no need to join it.");

  const { data: existing } = await supabase
    .from('team_members').select('id, status').eq('team_id', share.team_id).eq('user_id', userId).maybeSingle();
  if (existing && existing.status === 'accepted') {
    return { teamId: share.team_id, teamName: share.teams.name, alreadyMember: true };
  }

  const { error } = await supabase
    .from('team_members')
    .upsert(
      { team_id: share.team_id, user_id: userId, status: 'accepted', invited_by: share.teams.owner_id, responded_at: new Date().toISOString() },
      { onConflict: 'team_id,user_id' }
    );
  if (error) throw error;

  return { teamId: share.team_id, teamName: share.teams.name, alreadyMember: false };
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

async function createBook({ title, author, description, createdBy, themeColor, passingScore, bookType, envMode, envBgColor, envLineStyle }) {
  const { data, error } = await supabase
    .from('books').insert({
      title, author: author || null, description: description || null, created_by: createdBy,
      theme_color: themeColor || '#2F6F4F', passing_score: passingScore != null ? passingScore : 60,
      book_type: bookType || 'exercises_and_book',
      env_mode: envMode || 'default', env_bg_color: envBgColor || '#F6F5F1', env_line_style: envLineStyle || 'none'
    })
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

// Books a given learner is actually allowed to see: their own team's books,
// anything public (open or restricted — restricted ones just show as
// "request access" rather than being hidden), or anything they created.
// Facilitators/admins should call listBooks() instead to see everything.
async function listBooksForLearner(userId) {
  const { data, error } = await supabase.from('books').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  const all = data || [];
  const teamIds = new Set((await listTeamsForUser(userId)).filter(t => t.my_status === 'accepted').map(t => t.id));
  let myRequestStatus = {};
  const { data: reqs } = await supabase.from('book_access_requests').select('book_id, status').eq('requester_id', userId);
  (reqs || []).forEach(r => { myRequestStatus[r.book_id] = r.status; });
  return all
    .filter(b => b.created_by === userId || b.is_public || (b.team_id && teamIds.has(b.team_id)))
    .map(b => ({ ...b, my_request_status: (b.is_public && b.access_mode === 'restricted') ? (myRequestStatus[b.id] || null) : null }));
}

async function updateBookVisibility(id, { isPublic, accessMode, teamId }) {
  const patch = {};
  if (isPublic !== undefined) patch.is_public = !!isPublic;
  if (accessMode !== undefined) patch.access_mode = accessMode === 'restricted' ? 'restricted' : 'open';
  if (teamId !== undefined) patch.team_id = teamId || null;
  const { error } = await supabase.from('books').update(patch).eq('id', id);
  if (error) throw error;
}

async function requestBookAccess(bookId, requesterId) {
  const { data, error } = await supabase
    .from('book_access_requests')
    .upsert({ book_id: bookId, requester_id: requesterId, status: 'pending', decided_at: null }, { onConflict: 'book_id,requester_id' })
    .select().single();
  if (error) throw error;
  return data;
}

async function hasApprovedBookAccess(bookId, userId) {
  const { data, error } = await supabase.from('book_access_requests').select('status').eq('book_id', bookId).eq('requester_id', userId).maybeSingle();
  if (error) throw error;
  return !!(data && data.status === 'approved');
}

async function listIncomingBookAccessRequests() {
  const { data, error } = await supabase
    .from('book_access_requests')
    .select('id, book_id, status, created_at, books!inner(id, title), users!book_access_requests_requester_id_fkey(id, email, name)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(r => ({
    id: r.id, book_id: r.book_id, status: r.status, created_at: r.created_at,
    book_title: r.books ? r.books.title : null,
    requester_id: r.users ? r.users.id : null, requester_email: r.users ? r.users.email : null, requester_name: r.users ? r.users.name : null
  }));
}

async function decideBookAccessRequest(requestId, approve) {
  const { data: reqRow, error: reqErr } = await supabase.from('book_access_requests').select('id, book_id, requester_id').eq('id', requestId).maybeSingle();
  if (reqErr) throw reqErr;
  if (!reqRow) return null;
  const { error } = await supabase.from('book_access_requests').update({ status: approve ? 'approved' : 'denied', decided_at: new Date().toISOString() }).eq('id', requestId);
  if (error) throw error;
  return { bookId: reqRow.book_id, requesterId: reqRow.requester_id };
}

// Cover photo: replaces (and cleans up) whatever cover the book had before.
async function updateBookCover(id, storagePath) {
  const book = await getBookById(id);
  if (book && book.cover_storage_path && book.cover_storage_path !== storagePath) {
    await supabase.storage.from(FILES_BUCKET).remove([book.cover_storage_path]).catch(() => {});
  }
  const { error } = await supabase.from('books').update({ cover_storage_path: storagePath }).eq('id', id);
  if (error) throw error;
}

async function clearBookCover(id) {
  const book = await getBookById(id);
  if (book && book.cover_storage_path) {
    await supabase.storage.from(FILES_BUCKET).remove([book.cover_storage_path]).catch(() => {});
  }
  const { error } = await supabase.from('books').update({ cover_storage_path: null }).eq('id', id);
  if (error) throw error;
}

// The book's attached source document — a PDF/Word/etc. a learner can open
// or download alongside the exercises drawn from it.
async function updateBookDocument(id, { storagePath, originalName, mimeType, sizeBytes }) {
  const book = await getBookById(id);
  if (book && book.document_storage_path && book.document_storage_path !== storagePath) {
    await supabase.storage.from(FILES_BUCKET).remove([book.document_storage_path]).catch(() => {});
  }
  const { error } = await supabase.from('books').update({
    document_storage_path: storagePath, document_original_name: originalName,
    document_mime_type: mimeType, document_size_bytes: sizeBytes
  }).eq('id', id);
  if (error) throw error;
}

async function clearBookDocument(id) {
  const book = await getBookById(id);
  if (book && book.document_storage_path) {
    await supabase.storage.from(FILES_BUCKET).remove([book.document_storage_path]).catch(() => {});
  }
  const { error } = await supabase.from('books').update({
    document_storage_path: null, document_original_name: null, document_mime_type: null, document_size_bytes: null
  }).eq('id', id);
  if (error) throw error;
}

async function updateBook(id, { title, author, description, themeColor, passingScore, bookType, envMode, envBgColor, envLineStyle }) {
  const patch = {};
  if (title !== undefined) patch.title = title;
  if (author !== undefined) patch.author = author;
  if (description !== undefined) patch.description = description;
  if (themeColor !== undefined) patch.theme_color = themeColor;
  if (passingScore !== undefined) patch.passing_score = passingScore;
  if (bookType !== undefined) patch.book_type = bookType;
  if (envMode !== undefined) patch.env_mode = envMode;
  if (envBgColor !== undefined) patch.env_bg_color = envBgColor;
  if (envLineStyle !== undefined) patch.env_line_style = envLineStyle;
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

async function createQuestion({ bookId, questionText, options, correctOptionId, explanation, reference, color, createdBy, questionType, correctAnswerText }) {
  const { data, error } = await supabase
    .from('questions')
    .insert({
      book_id: bookId || null, question_text: questionText, options: options || [],
      correct_option_id: correctOptionId || null, explanation: explanation || null,
      reference: reference || null, color: color || '#2F6F4F', created_by: createdBy,
      question_type: questionType || 'mcq', correct_answer_text: correctAnswerText || null
    })
    .select().single();
  if (error) throw error;
  return data;
}

// includeAnswer=true (facilitator/admin managing content) returns everything
// including correct_option_id/correct_answer_text/explanation. includeAnswer=false
// (a learner doing the exercise) strips those so the answer can't be read from
// the network response before they check it — but still needs question_type so
// the client knows whether to render options or a free-text box.
async function listQuestionsForBook(bookId, includeAnswer) {
  const cols = includeAnswer
    ? '*'
    : 'id, book_id, question_text, options, question_type, created_at';
  const { data, error } = await supabase.from('questions').select(cols).eq('book_id', bookId).order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

async function getQuestionById(id) {
  const { data, error } = await supabase.from('questions').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

async function updateQuestion(id, { questionText, options, correctOptionId, explanation, reference, color, questionType, correctAnswerText }) {
  const patch = { updated_at: new Date().toISOString() };
  if (questionText !== undefined) patch.question_text = questionText;
  if (options !== undefined) patch.options = options;
  if (correctOptionId !== undefined) patch.correct_option_id = correctOptionId;
  if (explanation !== undefined) patch.explanation = explanation;
  if (reference !== undefined) patch.reference = reference;
  if (color !== undefined) patch.color = color;
  if (questionType !== undefined) patch.question_type = questionType;
  if (correctAnswerText !== undefined) patch.correct_answer_text = correctAnswerText;
  const { data, error } = await supabase.from('questions').update(patch).eq('id', id).select();
  if (error) throw error;
  return data && data[0];
}

async function deleteQuestion(id) {
  const { error } = await supabase.from('questions').delete().eq('id', id);
  if (error) throw error;
}

/* ---------------- marks / positions ----------------
 * There's no dedicated attempts table — "check answer" already records
 * each result into kv (app='exercises', key='q'+questionId, value has
 * .correct). These functions read that back and aggregate it per book so
 * facilitators/admins can see a gradebook, and learners can see their own
 * rank against everyone else who's attempted the same book. */

// Every learner's score on one book, sorted best-first with a rank
// attached. Only includes people who've answered at least one question
// in the book — someone who never opened it isn't "last place", they
// just haven't attempted it.
async function getBookMarks(bookId) {
  const questions = await listQuestionsForBook(bookId, true);
  const total = questions.length;
  if (!total) return [];
  const keys = questions.map(q => 'q' + q.id);

  const { data: rows, error } = await supabase
    .from('kv').select('scope_user_id, value')
    .eq('app', 'exercises').in('key', keys);
  if (error) throw error;

  const byUser = {};
  (rows || []).forEach(row => {
    let val;
    try { val = JSON.parse(row.value); } catch (e) { return; }
    const uid = row.scope_user_id;
    if (!byUser[uid]) byUser[uid] = { correct: 0, attempted: 0 };
    byUser[uid].attempted += 1;
    if (val && val.correct) byUser[uid].correct += 1;
  });

  const userIds = Object.keys(byUser).map(Number);
  if (!userIds.length) return [];

  const { data: users, error: uErr } = await supabase.from('users').select('id, name, email').in('id', userIds);
  if (uErr) throw uErr;
  const userMap = {};
  (users || []).forEach(u => { userMap[u.id] = u; });

  const out = userIds.map(uid => {
    const stats = byUser[uid];
    const percent = total ? Math.round((stats.correct / total) * 100) : 0;
    return {
      userId: uid, name: userMap[uid] ? userMap[uid].name : null, email: userMap[uid] ? userMap[uid].email : '',
      correct: stats.correct, attempted: stats.attempted, total, percent
    };
  });
  out.sort((a, b) => b.percent - a.percent || b.correct - a.correct);
  out.forEach((r, i) => { r.rank = i + 1; });
  return out;
}

// One learner's own standing on a book, plus how many people they're
// ranked among — undefined `mine` means they haven't attempted it yet.
async function getMyBookMark(bookId, userId) {
  const marks = await getBookMarks(bookId);
  const mine = marks.find(r => r.userId === userId) || null;
  return { totalParticipants: marks.length, mine };
}

// Every book a learner has access to AND has attempted at least one
// question in, each with their rank/percent/pass status — powers "your
// position in every course" on the learner side.
async function listMyPositions(userId) {
  const books = await listBooksForLearner(userId);
  const results = [];
  for (const book of books) {
    const { totalParticipants, mine } = await getMyBookMark(book.id, userId);
    if (mine) {
      results.push({
        bookId: book.id, title: book.title, themeColor: book.theme_color, passingScore: book.passing_score,
        percent: mine.percent, correct: mine.correct, total: mine.total,
        rank: mine.rank, totalParticipants, passed: mine.percent >= book.passing_score
      });
    }
  }
  return results;
}

/* ---------------- notes (facilitator-authored, book-like long-form content) ---------------- */

async function createNote({ title, body, createdBy, isPublic, accessMode, teamId }) {
  const { data, error } = await supabase
    .from('notes')
    .insert({
      title, body, created_by: createdBy, is_public: !!isPublic,
      access_mode: accessMode === 'restricted' ? 'restricted' : 'open', team_id: teamId || null
    })
    .select().single();
  if (error) throw error;
  return data;
}

async function getNoteById(id) {
  const { data, error } = await supabase.from('notes').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

// Every note a facilitator/admin manages (their own + everyone else's, so
// content can be co-managed the same way books already are).
async function listNotes() {
  const { data, error } = await supabase.from('notes').select('id, title, is_public, access_mode, team_id, created_by, created_at, updated_at, cover_storage_path, document_storage_path, document_original_name, document_mime_type, document_size_bytes').order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

// Notes a given learner may actually read: their own, public ones, or ones
// scoped to a team they've accepted membership in.
async function listNotesForLearner(userId) {
  const { data, error } = await supabase.from('notes').select('id, title, is_public, access_mode, team_id, created_by, created_at, updated_at, cover_storage_path, document_storage_path, document_original_name, document_mime_type, document_size_bytes').order('created_at', { ascending: false });
  if (error) throw error;
  const all = data || [];
  const teamIds = new Set((await listTeamsForUser(userId)).filter(t => t.my_status === 'accepted').map(t => t.id));
  let myRequestStatus = {};
  const { data: reqs } = await supabase.from('note_access_requests').select('note_id, status').eq('requester_id', userId);
  (reqs || []).forEach(r => { myRequestStatus[r.note_id] = r.status; });
  return all
    .filter(n => n.created_by === userId || n.is_public || (n.team_id && teamIds.has(n.team_id)))
    .map(n => ({ ...n, my_request_status: (n.is_public && n.access_mode === 'restricted') ? (myRequestStatus[n.id] || null) : null }));
}

async function updateNote(id, { title, body }) {
  const patch = { updated_at: new Date().toISOString() };
  if (title !== undefined) patch.title = title;
  if (body !== undefined) patch.body = body;
  const { data, error } = await supabase.from('notes').update(patch).eq('id', id).select();
  if (error) throw error;
  return data && data[0];
}

// Note photo: replaces (and cleans up) whatever cover the note had before.
// Mirrors updateBookCover/clearBookCover above.
async function updateNoteCover(id, storagePath) {
  const note = await getNoteById(id);
  if (note && note.cover_storage_path && note.cover_storage_path !== storagePath) {
    await supabase.storage.from(FILES_BUCKET).remove([note.cover_storage_path]).catch(() => {});
  }
  const { error } = await supabase.from('notes').update({ cover_storage_path: storagePath }).eq('id', id);
  if (error) throw error;
}

async function clearNoteCover(id) {
  const note = await getNoteById(id);
  if (note && note.cover_storage_path) {
    await supabase.storage.from(FILES_BUCKET).remove([note.cover_storage_path]).catch(() => {});
  }
  const { error } = await supabase.from('notes').update({ cover_storage_path: null }).eq('id', id);
  if (error) throw error;
}

// The note's attached document — mirrors updateBookDocument/clearBookDocument.
async function updateNoteDocument(id, { storagePath, originalName, mimeType, sizeBytes }) {
  const note = await getNoteById(id);
  if (note && note.document_storage_path && note.document_storage_path !== storagePath) {
    await supabase.storage.from(FILES_BUCKET).remove([note.document_storage_path]).catch(() => {});
  }
  const { error } = await supabase.from('notes').update({
    document_storage_path: storagePath, document_original_name: originalName,
    document_mime_type: mimeType, document_size_bytes: sizeBytes
  }).eq('id', id);
  if (error) throw error;
}

async function clearNoteDocument(id) {
  const note = await getNoteById(id);
  if (note && note.document_storage_path) {
    await supabase.storage.from(FILES_BUCKET).remove([note.document_storage_path]).catch(() => {});
  }
  const { error } = await supabase.from('notes').update({
    document_storage_path: null, document_original_name: null, document_mime_type: null, document_size_bytes: null
  }).eq('id', id);
  if (error) throw error;
}

async function updateNoteVisibility(id, { isPublic, accessMode, teamId }) {
  const patch = {};
  if (isPublic !== undefined) patch.is_public = !!isPublic;
  if (accessMode !== undefined) patch.access_mode = accessMode === 'restricted' ? 'restricted' : 'open';
  if (teamId !== undefined) patch.team_id = teamId || null;
  const { error } = await supabase.from('notes').update(patch).eq('id', id);
  if (error) throw error;
}

async function deleteNote(id) {
  const { error } = await supabase.from('notes').delete().eq('id', id);
  if (error) throw error;
}

async function requestNoteAccess(noteId, requesterId) {
  const { data, error } = await supabase
    .from('note_access_requests')
    .upsert({ note_id: noteId, requester_id: requesterId, status: 'pending', decided_at: null }, { onConflict: 'note_id,requester_id' })
    .select().single();
  if (error) throw error;
  return data;
}

async function hasApprovedNoteAccess(noteId, userId) {
  const { data, error } = await supabase.from('note_access_requests').select('status').eq('note_id', noteId).eq('requester_id', userId).maybeSingle();
  if (error) throw error;
  return !!(data && data.status === 'approved');
}

async function listIncomingNoteAccessRequests() {
  const { data, error } = await supabase
    .from('note_access_requests')
    .select('id, note_id, status, created_at, notes!inner(id, title), users!note_access_requests_requester_id_fkey(id, email, name)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(r => ({
    id: r.id, note_id: r.note_id, status: r.status, created_at: r.created_at,
    note_title: r.notes ? r.notes.title : null,
    requester_id: r.users ? r.users.id : null, requester_email: r.users ? r.users.email : null, requester_name: r.users ? r.users.name : null
  }));
}

async function decideNoteAccessRequest(requestId, approve) {
  const { data: reqRow, error: reqErr } = await supabase.from('note_access_requests').select('id, note_id, requester_id').eq('id', requestId).maybeSingle();
  if (reqErr) throw reqErr;
  if (!reqRow) return null;
  const { error } = await supabase.from('note_access_requests').update({ status: approve ? 'approved' : 'denied', decided_at: new Date().toISOString() }).eq('id', requestId);
  if (error) throw error;
  return { noteId: reqRow.note_id, requesterId: reqRow.requester_id };
}

/* ---------------- file share codes / QR access ---------------- */

function randomShareCode() {
  // Unambiguous alphabet (no 0/O/1/I) — this gets typed by hand sometimes,
  // not just scanned, so avoid characters people misread.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

// Creates a fresh, guaranteed-unique share code for a file. maxUses is
// null for unlimited redemptions, or a positive integer cap. expiresAt is
// null for a code that never expires, or an ISO timestamp string.
async function createFileShareCode(fileId, createdBy, maxUses, expiresAt) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomShareCode();
    const { data, error } = await supabase
      .from('file_share_codes')
      .insert({ file_id: fileId, code, created_by: createdBy, max_uses: maxUses || null, expires_at: expiresAt || null })
      .select()
      .maybeSingle();
    if (!error) return data;
    if (error.code !== '23505') throw error; // 23505 = unique_violation, retry with a new code
  }
  throw new Error('Could not generate a unique share code — try again.');
}

// Same idea, but one code covers several files at once (bundle share) —
// file_id on the code row itself is left null; the actual files live in
// file_share_code_files instead.
async function createBundleShareCode(fileIds, createdBy, maxUses, expiresAt) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomShareCode();
    const { data, error } = await supabase
      .from('file_share_codes')
      .insert({ file_id: null, code, created_by: createdBy, max_uses: maxUses || null, expires_at: expiresAt || null })
      .select()
      .maybeSingle();
    if (error) {
      if (error.code === '23505') continue; // unique_violation, retry with a new code
      throw error;
    }
    const { error: linkErr } = await supabase
      .from('file_share_code_files')
      .insert(fileIds.map(fileId => ({ share_code_id: data.id, file_id: fileId })));
    if (linkErr) throw linkErr;
    return data;
  }
  throw new Error('Could not generate a unique share code — try again.');
}

// Every share code (single-file or bundle) this user has created, newest
// first — powers a management list so they can see what's active/expired
// and revoke anything they no longer want shared.
async function listMyShareCodes(userId) {
  const { data, error } = await supabase
    .from('file_share_codes')
    .select('id, code, file_id, max_uses, use_count, active, expires_at, created_at, files(title, original_name)')
    .eq('created_by', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  const codes = data || [];
  const bundleIds = codes.filter(c => c.file_id == null).map(c => c.id);
  let filesByCode = {};
  if (bundleIds.length) {
    const { data: links, error: linkErr } = await supabase
      .from('file_share_code_files')
      .select('share_code_id, files(id, title, original_name)')
      .in('share_code_id', bundleIds);
    if (linkErr) throw linkErr;
    (links || []).forEach(l => {
      if (!filesByCode[l.share_code_id]) filesByCode[l.share_code_id] = [];
      filesByCode[l.share_code_id].push(l.files);
    });
  }
  return codes.map(c => ({
    id: c.id, code: c.code, maxUses: c.max_uses, useCount: c.use_count, active: c.active,
    expiresAt: c.expires_at, createdAt: c.created_at,
    files: c.file_id != null ? [c.files] : (filesByCode[c.id] || [])
  }));
}

async function listShareCodesForFile(fileId) {
  const { data, error } = await supabase
    .from('file_share_codes')
    .select('id, code, max_uses, use_count, active, expires_at, created_at')
    .eq('file_id', fileId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

// Scoped to createdBy/admin at the route layer — this just flips the flag.
async function revokeShareCode(id) {
  const { error } = await supabase.from('file_share_codes').update({ active: false }).eq('id', id);
  if (error) throw error;
}

async function getShareCodeByCode(code) {
  const { data, error } = await supabase
    .from('file_share_codes')
    .select('id, file_id, code, created_by, max_uses, use_count, active, expires_at, files(id, title, original_name, owner_id)')
    .eq('code', code.toUpperCase())
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  if (data.file_id == null) {
    // Bundle code — pull every linked file instead of the single `files` join.
    const { data: links, error: linkErr } = await supabase
      .from('file_share_code_files')
      .select('files(id, title, original_name, owner_id)')
      .eq('share_code_id', data.id);
    if (linkErr) throw linkErr;
    data.bundleFiles = (links || []).map(l => l.files);
  }
  return data;
}

// Validates the code, records use_count, and grants the redeeming user
// standing access to every file the code covers (one file for a normal
// code, several for a bundle) — upsert-safe, redeeming twice is harmless.
// Returns { files: [...], alreadyHadAccess } or throws a descriptive error.
async function redeemFileShareCode(code, userId) {
  const share = await getShareCodeByCode(code);
  if (!share || !share.active) throw new Error('That code is invalid or has been turned off.');
  if (share.expires_at && new Date(share.expires_at) < new Date()) {
    throw new Error('That code has expired.');
  }
  if (share.max_uses != null && share.use_count >= share.max_uses) {
    throw new Error('That code has reached its use limit.');
  }

  const targetFiles = share.file_id != null ? [share.files] : share.bundleFiles;
  const grantable = targetFiles.filter(f => f.owner_id !== userId); // skip files the redeemer already owns
  if (!grantable.length) throw new Error("That's your own file — no code needed.");

  let anyNew = false;
  for (const f of grantable) {
    const { data: existing } = await supabase
      .from('file_share_access').select('id').eq('file_id', f.id).eq('user_id', userId).maybeSingle();
    if (!existing) {
      anyNew = true;
      const { error: insertErr } = await supabase
        .from('file_share_access')
        .insert({ file_id: f.id, share_code_id: share.id, user_id: userId });
      if (insertErr) throw insertErr;
    }
  }
  if (anyNew) {
    const { error: bumpErr } = await supabase
      .from('file_share_codes').update({ use_count: share.use_count + 1 }).eq('id', share.id);
    if (bumpErr) throw bumpErr;
  }

  return {
    files: grantable.map(f => ({ id: f.id, title: f.title || f.original_name })),
    ownerId: grantable[0].owner_id,
    alreadyHadAccess: !anyNew
  };
}

async function hasShareAccess(fileId, userId) {
  const { data, error } = await supabase
    .from('file_share_access').select('id').eq('file_id', fileId).eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return !!data;
}

// Files someone gained access to via a redeemed share code — "Shared with
// me". Unions single-file share codes with account-wide ones (a whole
// owner's document set), de-duplicated by file id.
async function listFilesSharedWithUser(userId) {
  const { data, error } = await supabase
    .from('file_share_access')
    .select('created_at, files!inner(id, original_name, title, description, mime_type, size_bytes, created_at, owner_id, users!files_owner_id_fkey(email, name))')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  const byId = new Map();
  (data || []).forEach(r => {
    byId.set(r.files.id, {
      id: r.files.id, original_name: r.files.original_name, title: r.files.title, description: r.files.description,
      mime_type: r.files.mime_type, size_bytes: r.files.size_bytes, created_at: r.files.created_at,
      owner_id: r.files.owner_id, owner_email: r.files.users ? r.files.users.email : null,
      owner_name: r.files.users ? r.files.users.name : null, shared_at: r.created_at, via: 'file'
    });
  });

  const { data: grants, error: gErr } = await supabase
    .from('account_share_access').select('owner_id, created_at').eq('viewer_id', userId);
  if (gErr) throw gErr;
  const ownerIds = (grants || []).map(g => g.owner_id);
  if (ownerIds.length) {
    const grantedAt = new Map((grants || []).map(g => [g.owner_id, g.created_at]));
    const { data: files, error: fErr } = await supabase
      .from('files')
      .select('id, original_name, title, description, mime_type, size_bytes, created_at, owner_id, users!files_owner_id_fkey(email, name)')
      .in('owner_id', ownerIds);
    if (fErr) throw fErr;
    (files || []).forEach(f => {
      if (byId.has(f.id)) return; // already have standing access via a direct file code
      byId.set(f.id, {
        id: f.id, original_name: f.original_name, title: f.title, description: f.description,
        mime_type: f.mime_type, size_bytes: f.size_bytes, created_at: f.created_at,
        owner_id: f.owner_id, owner_email: f.users ? f.users.email : null,
        owner_name: f.users ? f.users.name : null, shared_at: grantedAt.get(f.owner_id), via: 'account'
      });
    });
  }
  return Array.from(byId.values()).sort((a, b) => new Date(b.shared_at) - new Date(a.shared_at));
}

async function listAdminIds() {
  const { data, error } = await supabase.from('users').select('id').eq('role', 'admin');
  if (error) throw error;
  return (data || []).map(u => u.id);
}

/* ---------------- account-wide share codes / QR ---------------- */
// Same shape as file share codes above, but the redeemer gets standing
// access to every file the owner has (see listFilesSharedWithUser, which
// now unions both sources) instead of just one.

async function createAccountShareCode(ownerId, maxUses) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomShareCode();
    const { data, error } = await supabase
      .from('account_share_codes')
      .insert({ owner_id: ownerId, code, max_uses: maxUses || null })
      .select()
      .maybeSingle();
    if (!error) return data;
    if (error.code !== '23505') throw error;
  }
  throw new Error('Could not generate a unique share code — try again.');
}

// The owner's current active, unexpired code, if any — so "Share my
// documents" can reuse one QR instead of minting a new one on every visit.
async function getActiveAccountShareCode(ownerId) {
  const { data, error } = await supabase
    .from('account_share_codes')
    .select('id, code, max_uses, use_count, active, created_at')
    .eq('owner_id', ownerId).eq('active', true)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data;
}

async function revokeAccountShareCode(id, ownerId) {
  const { error } = await supabase.from('account_share_codes').update({ active: false }).eq('id', id).eq('owner_id', ownerId);
  if (error) throw error;
}

async function getAccountShareCodeByCode(code) {
  const { data, error } = await supabase
    .from('account_share_codes')
    .select('id, owner_id, code, max_uses, use_count, active, users!account_share_codes_owner_id_fkey(name, email)')
    .eq('code', code.toUpperCase())
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Validates the code and grants the redeemer standing access to the
// owner's whole document set (upsert — redeeming twice is harmless).
async function redeemAccountShareCode(code, viewerId) {
  const share = await getAccountShareCodeByCode(code);
  if (!share || !share.active) throw new Error('That code is invalid or has been turned off.');
  if (share.max_uses != null && share.use_count >= share.max_uses) {
    throw new Error('That code has reached its use limit.');
  }
  if (share.owner_id === viewerId) throw new Error("That's your own code — no need to redeem it.");

  const { data: existing } = await supabase
    .from('account_share_access').select('id').eq('owner_id', share.owner_id).eq('viewer_id', viewerId).maybeSingle();

  if (!existing) {
    const { error: insertErr } = await supabase
      .from('account_share_access')
      .insert({ owner_id: share.owner_id, viewer_id: viewerId, share_code_id: share.id });
    if (insertErr) throw insertErr;
    const { error: bumpErr } = await supabase
      .from('account_share_codes').update({ use_count: share.use_count + 1 }).eq('id', share.id);
    if (bumpErr) throw bumpErr;
  }

  return {
    ownerId: share.owner_id,
    ownerName: share.users ? (share.users.name || share.users.email) : 'that account',
    alreadyHadAccess: !!existing
  };
}

async function hasAccountShareAccess(ownerId, viewerId) {
  const { data, error } = await supabase
    .from('account_share_access').select('id').eq('owner_id', ownerId).eq('viewer_id', viewerId).maybeSingle();
  if (error) throw error;
  return !!data;
}

// Everyone the owner has granted account-wide access to — shown on My
// Account with a Revoke button next to each.
async function listAccountViewers(ownerId) {
  const { data, error } = await supabase
    .from('account_share_access')
    .select('viewer_id, created_at, users!account_share_access_viewer_id_fkey(name, email)')
    .eq('owner_id', ownerId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(r => ({ viewerId: r.viewer_id, name: r.users ? r.users.name : null, email: r.users ? r.users.email : null, sharedAt: r.created_at }));
}

async function revokeAccountViewer(ownerId, viewerId) {
  const { error } = await supabase.from('account_share_access').delete().eq('owner_id', ownerId).eq('viewer_id', viewerId);
  if (error) throw error;
}

/* ---------------- screen sharing (WebRTC signaling over polling) ---------------- */

function randomScreenShareCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

async function createScreenShareSession(hostId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomScreenShareCode();
    const { data, error } = await supabase
      .from('screen_share_sessions')
      .insert({ code, host_id: hostId })
      .select()
      .maybeSingle();
    if (!error) return data;
    if (error.code !== '23505') throw error;
  }
  throw new Error('Could not start a screen-share session — try again.');
}

async function getScreenShareSession(code) {
  const { data, error } = await supabase
    .from('screen_share_sessions').select('*, users!screen_share_sessions_host_id_fkey(email, name)').eq('code', code.toUpperCase()).maybeSingle();
  if (error) throw error;
  return data;
}

async function listWaitingScreenShareSessions() {
  const { data, error } = await supabase
    .from('screen_share_sessions')
    .select('id, code, status, created_at, users!screen_share_sessions_host_id_fkey(id, email, name)')
    .in('status', ['waiting', 'connected'])
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(s => ({
    id: s.id, code: s.code, status: s.status, created_at: s.created_at,
    host_email: s.users ? s.users.email : null, host_name: s.users ? s.users.name : null
  }));
}

async function setScreenShareOffer(code, sdp) {
  const { error } = await supabase.from('screen_share_sessions').update({ offer_sdp: sdp, updated_at: new Date().toISOString() }).eq('code', code.toUpperCase());
  if (error) throw error;
}

async function joinScreenShareSession(code, viewerId) {
  const { data, error } = await supabase
    .from('screen_share_sessions')
    .update({ viewer_id: viewerId, status: 'connected', updated_at: new Date().toISOString() })
    .eq('code', code.toUpperCase())
    .select()
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function setScreenShareAnswer(code, sdp) {
  const { error } = await supabase.from('screen_share_sessions').update({ answer_sdp: sdp, updated_at: new Date().toISOString() }).eq('code', code.toUpperCase());
  if (error) throw error;
}

async function addScreenShareCandidate(code, role, candidate) {
  const col = role === 'host' ? 'host_candidates' : 'viewer_candidates';
  const session = await getScreenShareSession(code);
  if (!session) throw new Error('Session not found');
  const next = (session[col] || []).concat([candidate]);
  const { error } = await supabase.from('screen_share_sessions').update({ [col]: next, updated_at: new Date().toISOString() }).eq('code', code.toUpperCase());
  if (error) throw error;
}

async function endScreenShareSession(code) {
  const { error } = await supabase.from('screen_share_sessions').update({ status: 'ended', updated_at: new Date().toISOString() }).eq('code', code.toUpperCase());
  if (error) throw error;
}

/* ---------------- messages (admin → user popups, and now user ↔ user chat between teammates) ---------------- */

async function insertMessage({ recipientId, senderId, body }) {
  const { data, error } = await supabase
    .from('messages').insert({ recipient_id: recipientId, sender_id: senderId, body }).select().single();
  if (error) throw error;
  return data;
}

// Includes sender name/role now (not just id) so the toast can say "Message
// from admin" vs "Message from <name>" correctly instead of always assuming admin.
async function listUnreadMessagesForUser(userId) {
  const { data, error } = await supabase
    .from('messages')
    .select('id, body, created_at, sender_id, users!messages_sender_id_fkey(name, email, role)')
    .eq('recipient_id', userId).is('read_at', null).order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []).map(m => ({
    id: m.id, body: m.body, created_at: m.created_at, sender_id: m.sender_id,
    sender_name: m.users ? m.users.name : null, sender_role: m.users ? m.users.role : null
  }));
}

async function markMessageRead(id, userId) {
  // Scoped to recipient_id so a user can only mark their own messages read.
  const { error } = await supabase.from('messages').update({ read_at: new Date().toISOString() }).eq('id', id).eq('recipient_id', userId);
  if (error) throw error;
}

// Everyone userId shares at least one accepted team with — the pool of
// people they're allowed to direct-message. De-duplicated across teams.
async function listMessageableUsers(userId) {
  const { data: memberships, error } = await supabase
    .from('team_members').select('team_id').eq('user_id', userId).eq('status', 'accepted');
  if (error) throw error;
  const teamIds = (memberships || []).map(m => m.team_id);
  if (!teamIds.length) return [];
  const { data, error: err2 } = await supabase
    .from('team_members')
    .select('user_id, users!team_members_user_id_fkey(id, name, email)')
    .in('team_id', teamIds).eq('status', 'accepted').neq('user_id', userId);
  if (err2) throw err2;
  const seen = new Map();
  (data || []).forEach(r => { if (r.users) seen.set(r.users.id, { id: r.users.id, name: r.users.name, email: r.users.email }); });
  return Array.from(seen.values());
}

async function areTeammates(userId1, userId2) {
  const list = await listMessageableUsers(userId1);
  return list.some(u => u.id === userId2);
}

async function sendUserMessage(senderId, recipientId, body) {
  return insertMessage({ recipientId, senderId, body });
}

// Full back-and-forth history between two people, oldest first.
async function listConversation(userId, otherUserId) {
  const { data, error } = await supabase
    .from('messages')
    .select('id, sender_id, recipient_id, body, created_at, read_at')
    .or(`and(sender_id.eq.${userId},recipient_id.eq.${otherUserId}),and(sender_id.eq.${otherUserId},recipient_id.eq.${userId})`)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

// Marks every message otherUserId sent to userId as read — called when
// userId opens that thread.
async function markThreadRead(userId, otherUserId) {
  const { error } = await supabase.from('messages')
    .update({ read_at: new Date().toISOString() })
    .eq('recipient_id', userId).eq('sender_id', otherUserId).is('read_at', null);
  if (error) throw error;
}

// One row per person userId has ever exchanged a message with, newest
// first, with the last message preview and unread count — powers the inbox.
async function listMessageThreads(userId) {
  const { data, error } = await supabase
    .from('messages')
    .select('id, sender_id, recipient_id, body, created_at, read_at')
    .or(`sender_id.eq.${userId},recipient_id.eq.${userId}`)
    .order('created_at', { ascending: false });
  if (error) throw error;
  const byPeer = new Map();
  (data || []).forEach(m => {
    const peerId = m.sender_id === userId ? m.recipient_id : m.sender_id;
    if (!peerId) return; // system/admin messages with no real sender
    if (!byPeer.has(peerId)) byPeer.set(peerId, { peerId, lastBody: m.body, lastAt: m.created_at, unread: 0 });
    if (m.recipient_id === userId && !m.read_at) byPeer.get(peerId).unread++;
  });
  const peerIds = Array.from(byPeer.keys());
  if (!peerIds.length) return [];
  const { data: users, error: uErr } = await supabase.from('users').select('id, name, email').in('id', peerIds);
  if (uErr) throw uErr;
  const userMap = new Map((users || []).map(u => [u.id, u]));
  return peerIds.map(pid => {
    const entry = byPeer.get(pid);
    const u = userMap.get(pid);
    return { peerId: pid, peerName: u ? u.name : null, peerEmail: u ? u.email : null, lastBody: entry.lastBody, lastAt: entry.lastAt, unread: entry.unread };
  }).sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));
}

module.exports = {
  supabase,
  getUserByEmail, getUserById, insertUser, listUsers, updateUserRole,
  setUserSuspended, updateUserPassword, deleteUser, updateUserMaxFiles, countFilesForOwner,
  updateUserProfile, getPublicProfile, getOverallRanking,
  kvGet, kvSet, kvDelete, kvList, kvCountByPrefix, kvRowsForAppKey, kvDeleteAllForUser,
  insertFileRecord, getFileById, listFilesForOwner, listPublicFiles, listAllFiles,
  updateFilePublic, updateFileDetails, updateFileAccessMode, deleteFileRecord, uploadFileToStorage, getFileSignedUrl,
  requestFileAccess, listIncomingAccessRequests, decideAccessRequest, hasApprovedAccess,
  createTeam, deleteTeam, listTeamsForUser, getTeamById, listTeamMembers, isAcceptedTeamMember,
  searchInvitableUsers, inviteToTeam, respondToTeamInvite, removeTeamMember, listFilesForUserTeams, updateFileTeam,
  createTeamJoinCode, getActiveTeamJoinCode, revokeTeamJoinCode, getTeamJoinCodeByCode, redeemTeamJoinCode,
  createBook, listBooks, listBooksForLearner, getBookById, updateBook, deleteBook, updateBookVisibility,
  updateBookCover, clearBookCover, updateBookDocument, clearBookDocument,
  requestBookAccess, hasApprovedBookAccess, listIncomingBookAccessRequests, decideBookAccessRequest,
  createQuestion, listQuestionsForBook, getQuestionById, updateQuestion, deleteQuestion,
  getBookMarks, getMyBookMark, listMyPositions,
  createNote, getNoteById, listNotes, listNotesForLearner, updateNote, updateNoteVisibility, deleteNote,
  updateNoteCover, clearNoteCover, updateNoteDocument, clearNoteDocument,
  requestNoteAccess, hasApprovedNoteAccess, listIncomingNoteAccessRequests, decideNoteAccessRequest,
  insertMessage, listUnreadMessagesForUser, markMessageRead,
  listMessageableUsers, areTeammates, sendUserMessage, listConversation, markThreadRead, listMessageThreads,
  createFileShareCode, createBundleShareCode, listMyShareCodes, listShareCodesForFile, revokeShareCode, getShareCodeByCode, redeemFileShareCode,
  hasShareAccess, listFilesSharedWithUser, listAdminIds,
  createAccountShareCode, getActiveAccountShareCode, revokeAccountShareCode, getAccountShareCodeByCode,
  redeemAccountShareCode, hasAccountShareAccess, listAccountViewers, revokeAccountViewer,
  createScreenShareSession, getScreenShareSession, listWaitingScreenShareSessions,
  setScreenShareOffer, joinScreenShareSession, setScreenShareAnswer, addScreenShareCandidate, endScreenShareSession
};
