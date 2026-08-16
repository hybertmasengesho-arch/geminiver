const express = require('express');
const {
  createTeam, listTeamsForUser, getTeamById, listTeamMembers, isAcceptedTeamMember,
  searchInvitableUsers, inviteToTeam, respondToTeamInvite, removeTeamMember, listFilesForUserTeams,
  insertMessage
} = require('../db');
const { requireAuth, blockIfSuspended } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// A team member cap keeps this a small trusted group, not an open share —
// matches the "merge ~5 accounts" use case this was built for. The owner
// counts as one of these.
const MAX_TEAM_SIZE = 8;

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
    const acceptedOrPending = members.filter(m => m.status !== 'declined').length;
    if (acceptedOrPending >= MAX_TEAM_SIZE) {
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

module.exports = router;
