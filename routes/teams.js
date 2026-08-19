const express = require('express');
const {
  createTeam, deleteTeam, listTeamsForUser, getTeamById, listTeamMembers, isAcceptedTeamMember,
  searchInvitableUsers, inviteToTeam, respondToTeamInvite, removeTeamMember, listFilesForUserTeams,
  createTeamJoinCode, getActiveTeamJoinCode, revokeTeamJoinCode, getTeamJoinCodeByCode, redeemTeamJoinCode,
  insertMessage
} = require('../db');
const { requireAuth, blockIfSuspended } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// A team member cap keeps this a small trusted group, not an open share —
// matches the "merge ~5 accounts" use case this was built for. The owner
// counts as one of these.
const MAX_TEAM_SIZE = 8;

function acceptedOrPendingCount(members) {
  return members.filter(m => m.status !== 'declined').length;
}

// POST /api/teams  { name }
router.post('/', blockIfSuspended, async (req, res) => {
  const name = (req.body && req.body.name ? String(req.body.name).trim() : '').slice(0, 100);
  if (!name) return res.status(400).json({ error: 'Team name is required.' });
  try {
    const team = await createTeam(req.user.id, name);
    res.status(201).json({ team });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not create team' });
  }
});

// GET /api/teams/mine — every team I own or belong to, with my own status.
router.get('/mine', async (req, res) => {
  try {
    const teams = await listTeamsForUser(req.user.id);
    res.json({ teams });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load teams' });
  }
});

// GET /api/teams/files — files shared with any team I'm an accepted member of.
router.get('/files', async (req, res) => {
  try {
    res.json({ files: await listFilesForUserTeams(req.user.id) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load team files' });
  }
});

async function loadOwnedTeam(req, res, next) {
  try {
    const team = await getTeamById(req.params.id);
    if (!team) return res.status(404).json({ error: 'Team not found' });
    if (team.owner_id !== req.user.id) return res.status(403).json({ error: 'Only the team creator can do this.' });
    req.team = team;
    next();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load team' });
  }
}

// GET /api/teams/:id/members — owner or any accepted member can see the roster.
router.get('/:id/members', async (req, res) => {
  try {
    const team = await getTeamById(req.params.id);
    if (!team) return res.status(404).json({ error: 'Team not found' });
    const isOwner = team.owner_id === req.user.id;
    const isMember = isOwner || await isAcceptedTeamMember(team.id, req.user.id);
    if (!isMember) return res.status(403).json({ error: 'Not a member of this team.' });
    res.json({ team, members: await listTeamMembers(team.id) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load members' });
  }
});

// GET /api/teams/:id/search?q=... — owner-only: find users by name/email to invite.
router.get('/:id/search', loadOwnedTeam, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ users: [] });
  try {
    res.json({ users: await searchInvitableUsers(req.team.id, req.user.id, q) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not search users' });
  }
});

// POST /api/teams/:id/invite  { userId } — owner-only.
router.post('/:id/invite', blockIfSuspended, loadOwnedTeam, async (req, res) => {
  const userId = req.body && req.body.userId;
  if (!userId) return res.status(400).json({ error: 'userId is required.' });
  try {
    const members = await listTeamMembers(req.team.id);
    if (acceptedOrPendingCount(members) >= MAX_TEAM_SIZE) {
      return res.status(403).json({ error: `Teams are capped at ${MAX_TEAM_SIZE} members.` });
    }
    await inviteToTeam(req.team.id, userId, req.user.id);
    insertMessage({
      recipientId: userId, senderId: req.user.id,
      body: `${req.user.email} invited you to join their team "${req.team.name}". Review it from My Teams.`
    }).catch(() => {});
    res.status(201).json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not send invite' });
  }
});

// POST /api/teams/:id/respond  { accept: boolean } — the invited user themself.
router.post('/:id/respond', blockIfSuspended, async (req, res) => {
  try {
    const team = await getTeamById(req.params.id);
    if (!team) return res.status(404).json({ error: 'Team not found' });
    const accept = !!(req.body && req.body.accept);
    const result = await respondToTeamInvite(team.id, req.user.id, accept);
    if (!result) return res.status(404).json({ error: 'No pending invite found for you on this team.' });
    insertMessage({
      recipientId: team.owner_id, senderId: req.user.id,
      body: `${req.user.email} ${accept ? 'accepted' : 'declined'} your invite to team "${team.name}".`
    }).catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not respond to invite' });
  }
});

// DELETE /api/teams/:id/members/:userId — owner-only, removes a member or
// cancels a still-pending invite.
router.delete('/:id/members/:userId', blockIfSuspended, loadOwnedTeam, async (req, res) => {
  try {
    await removeTeamMember(req.team.id, req.params.userId);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not remove member' });
  }
});

/* ---------------- join by code / QR ---------------- */

// GET /api/teams/:id/join-code — owner-only: the team's current active,
// unexpired code, if any. The panel calls this first so it can reuse one
// QR instead of minting a fresh code on every page load.
router.get('/:id/join-code', loadOwnedTeam, async (req, res) => {
  try {
    const share = await getActiveTeamJoinCode(req.team.id);
    res.json({ code: share ? share.code : null, expiresAt: share ? share.expires_at : null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load the join code' });
  }
});

// POST /api/teams/:id/join-code — owner-only: mint a fresh code, replacing
// any active one (so an old QR someone still has stops working once you
// regenerate). The new code is good for 3 days if nobody uses it.
router.post('/:id/join-code', blockIfSuspended, loadOwnedTeam, async (req, res) => {
  try {
    const existing = await getActiveTeamJoinCode(req.team.id);
    if (existing) await revokeTeamJoinCode(existing.id, req.team.id);
    const share = await createTeamJoinCode(req.team.id, req.user.id);
    res.status(201).json({ code: share.code, expiresAt: share.expires_at });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Could not create a join code' });
  }
});

// DELETE /api/teams/:id/join-code — owner-only: turn off the current code
// early so it can no longer be scanned/typed in. Anyone who already joined
// through it keeps their membership — this only stops new people joining,
// exactly like revoking an account/file share code works elsewhere.
router.delete('/:id/join-code', blockIfSuspended, loadOwnedTeam, async (req, res) => {
  try {
    const existing = await getActiveTeamJoinCode(req.team.id);
    if (existing) await revokeTeamJoinCode(existing.id, req.team.id);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not turn off the join code' });
  }
});

// POST /api/teams/join  { code } — any signed-in user: redeem a join code
// to become an accepted member immediately, no invite/accept step. Subject
// to the same MAX_TEAM_SIZE cap the owner-invite path uses.
router.post('/join', blockIfSuspended, async (req, res) => {
  const code = (req.body && req.body.code ? String(req.body.code).trim() : '');
  if (!code) return res.status(400).json({ error: 'Enter a code first.' });
  try {
    const share = await getTeamJoinCodeByCode(code);
    if (share) {
      const members = await listTeamMembers(share.team_id);
      const already = members.find(m => m.user_id === req.user.id && m.status === 'accepted');
      if (!already && acceptedOrPendingCount(members) >= MAX_TEAM_SIZE) {
        return res.status(403).json({ error: `That team is full — teams are capped at ${MAX_TEAM_SIZE} members.` });
      }
    }
    const result = await redeemTeamJoinCode(code, req.user.id);
    if (!result.alreadyMember) {
      const team = await getTeamById(result.teamId);
      if (team) {
        insertMessage({
          recipientId: team.owner_id, senderId: req.user.id,
          body: `${req.user.email} joined your team "${team.name}" using the join code.`
        }).catch(() => {});
      }
    }
    res.json({ ok: true, teamId: result.teamId, teamName: result.teamName, alreadyMember: result.alreadyMember });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Could not join that team' });
  }
});

// DELETE /api/teams/:id — creator-only. Removes the team outright; members
// lose access to files shared with it, but the files themselves stay put
// in the owner's account (they just stop being team-shared).
router.delete('/:id', blockIfSuspended, loadOwnedTeam, async (req, res) => {
  try {
    await deleteTeam(req.team.id);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not delete team' });
  }
});

module.exports = router;
