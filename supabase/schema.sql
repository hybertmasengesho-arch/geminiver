-- Reasoning Hub — Supabase (Postgres) schema
-- Run this once in Supabase → SQL Editor → New Query → Run.

create table if not exists users (
  id            bigint generated always as identity primary key,
  email         text not null unique,
  password_hash text not null,
  name          text,
  phone         text,
  instagram_url text,
  tiktok_url    text,
  role          text not null default 'user' check (role in ('user', 'admin')),
  suspended     boolean not null default false,   -- admin can pause an account without deleting it
  max_files     integer not null default 10,      -- admin-adjustable cap on this user's saved documents
  created_at    timestamptz not null default now()
);

-- Safe to re-run against a database that predates these columns:
alter table users add column if not exists max_files integer not null default 10;
alter table users add column if not exists phone text;
alter table users add column if not exists instagram_url text;
alter table users add column if not exists tiktok_url text;

create table if not exists kv (
  scope_user_id bigint not null,   -- 0 = shared/global scope, otherwise a users.id
  app           text not null,     -- 'matrix' | 'reasoning' | 'prep30' | ...
  key           text not null,
  value         text not null,
  updated_at    timestamptz not null default now(),
  primary key (scope_user_id, app, key)
);

create index if not exists idx_kv_app_key on kv (app, key);

-- Files are now stored in Supabase Storage (a bucket called "documents"),
-- not on local disk — local disk doesn't persist on Netlify. This table
-- just tracks metadata; storage_path points at the actual file in the bucket.
create table if not exists files (
  id            bigint generated always as identity primary key,
  owner_id      bigint not null references users(id) on delete cascade,
  original_name text not null,
  title         text,        -- optional display title; falls back to original_name if blank
  description   text,        -- optional description shown on Public Files
  storage_path  text not null unique,   -- path inside the "documents" bucket
  mime_type     text not null,
  size_bytes    bigint not null,
  is_public     boolean not null default false,
  access_mode   text not null default 'open' check (access_mode in ('open', 'restricted')),
  created_at    timestamptz not null default now()
);

alter table files add column if not exists title text;
alter table files add column if not exists description text;
alter table files add column if not exists access_mode text not null default 'open';
alter table files drop constraint if exists files_access_mode_check;
alter table files add constraint files_access_mode_check check (access_mode in ('open', 'restricted'));

create index if not exists idx_files_owner on files (owner_id);
create index if not exists idx_files_public on files (is_public);

-- "Protected" public files (is_public = true, access_mode = 'restricted') stay
-- listed on Public Files but can't be opened until the owner approves a
-- request. One row per (file, requester) — re-requesting after a denial just
-- flips the same row back to pending (see db.js requestFileAccess).
create table if not exists file_access_requests (
  id            bigint generated always as identity primary key,
  file_id       bigint not null references files(id) on delete cascade,
  requester_id  bigint not null references users(id) on delete cascade,
  status        text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  created_at    timestamptz not null default now(),
  decided_at    timestamptz,
  unique (file_id, requester_id)
);

create index if not exists idx_far_file on file_access_requests (file_id);
create index if not exists idx_far_requester on file_access_requests (requester_id);

-- Teams — lets a small group (e.g. 5 users) share private files with each
-- other without making them public. The creator is the team's owner: only
-- they can search for users and send invites. Everyone else can only accept
-- or decline the invite sent to them.
create table if not exists teams (
  id            bigint generated always as identity primary key,
  name          text not null,
  owner_id      bigint not null references users(id) on delete cascade,
  created_at    timestamptz not null default now()
);

create index if not exists idx_teams_owner on teams (owner_id);

-- One row per (team, invited user). status starts 'pending' when the owner
-- sends an invite; the invited user flips it to 'accepted' or 'declined'.
-- The owner is auto-inserted as 'accepted' the moment the team is created.
create table if not exists team_members (
  id            bigint generated always as identity primary key,
  team_id       bigint not null references teams(id) on delete cascade,
  user_id       bigint not null references users(id) on delete cascade,
  status        text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  invited_by    bigint references users(id) on delete set null,
  created_at    timestamptz not null default now(),
  responded_at  timestamptz,
  unique (team_id, user_id)
);

create index if not exists idx_team_members_team on team_members (team_id);
create index if not exists idx_team_members_user on team_members (user_id);

-- A private file can optionally be shared with one team instead of (or as
-- well as) being public. Any 'accepted' member of that team can then view
-- and download it, same as the owner can.
alter table files add column if not exists team_id bigint references teams(id) on delete set null;
create index if not exists idx_files_team on files (team_id);

alter table teams enable row level security;
alter table team_members enable row level security;

-- Join-by-code / QR for teams. Lets the owner mint a code anyone can
-- redeem to join instantly (as an 'accepted' member, no invite/accept step)
-- instead of the owner having to search and invite each person. The code
-- itself expires 3 days after being minted if nobody uses it — but once
-- someone redeems it they become a normal team_members row, completely
-- independent of this code afterward: they keep access until the owner
-- removes them via the existing remove-member flow, regardless of whether
-- this code later expires or is turned off.
create table if not exists team_join_codes (
  id            bigint generated always as identity primary key,
  team_id       bigint not null references teams(id) on delete cascade,
  code          text not null unique,
  created_by    bigint not null references users(id) on delete cascade,
  active        boolean not null default true,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now()
);

create index if not exists idx_tjc_team on team_join_codes (team_id);
create index if not exists idx_tjc_code on team_join_codes (code);

alter table team_join_codes enable row level security;

-- Widen the role check to add 'facilitator' — a trusted content-management
-- role between 'user' and 'admin': can create/edit exercises but can't
-- manage accounts. Only an existing admin can grant this (see admin.html).
alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check check (role in ('user', 'admin', 'facilitator'));

-- A "book" just groups a set of practice questions under a title/author —
-- e.g. a textbook chapter or topic. created_by is kept for reference but a
-- facilitator/admin can edit any book, not just their own.
create table if not exists books (
  id            bigint generated always as identity primary key,
  title         text not null,
  author        text,
  description   text,
  created_by    bigint references users(id) on delete set null,
  created_at    timestamptz not null default now()
);

-- One multiple-choice question. options is a JSON array like
-- [{"id":"a","text":"..."},{"id":"b","text":"..."}] — correct_option_id
-- must match one of those ids. color is the hex used to highlight the
-- correct answer once a learner checks their answer (defaults to the
-- site's green). reference is an optional URL or citation shown alongside
-- the explanation after checking.
create table if not exists questions (
  id                bigint generated always as identity primary key,
  book_id           bigint references books(id) on delete cascade,
  question_text     text not null,
  options           jsonb not null,
  correct_option_id text not null,
  explanation       text,
  reference         text,
  color             text not null default '#2F6F4F',
  created_by        bigint references users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_questions_book on questions (book_id);

alter table books enable row level security;
alter table questions enable row level security;

-- Admin-to-user messages, shown as a popup toast the next time that user
-- loads any page. read_at is set once the user dismisses it.
create table if not exists messages (
  id            bigint generated always as identity primary key,
  recipient_id  bigint not null references users(id) on delete cascade,
  sender_id     bigint references users(id) on delete set null,
  body          text not null,
  created_at    timestamptz not null default now(),
  read_at       timestamptz
);

create index if not exists idx_messages_recipient_unread on messages (recipient_id) where read_at is null;

-- Backend uses the SERVICE ROLE key, which bypasses RLS entirely — this is
-- a safety net against the anon/public key ever touching these tables.
alter table users enable row level security;
alter table kv enable row level security;
alter table files enable row level security;
alter table messages enable row level security;
alter table file_access_requests enable row level security;

-- ============================================================
-- Notes + shared visibility for books/notes (reader/team/public)
-- Added to support facilitator-authored notes and access control
-- that mirrors the existing files model: is_public + access_mode
-- ('open' = anyone signed in can read; 'restricted' = must request
-- approval, i.e. "reader" access) + optional team_id scoping.
-- ============================================================

create table if not exists notes (
  id            bigint generated always as identity primary key,
  title         text not null,
  body          text not null,
  created_by    bigint references users(id) on delete set null,
  is_public     boolean not null default false,
  access_mode   text not null default 'open' check (access_mode in ('open', 'restricted')),
  team_id       bigint references teams(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_notes_public on notes (is_public);
create index if not exists idx_notes_team on notes (team_id);
create index if not exists idx_notes_created_by on notes (created_by);

create table if not exists note_access_requests (
  id            bigint generated always as identity primary key,
  note_id       bigint not null references notes(id) on delete cascade,
  requester_id  bigint not null references users(id) on delete cascade,
  status        text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  created_at    timestamptz not null default now(),
  decided_at    timestamptz,
  unique (note_id, requester_id)
);

create index if not exists idx_nar_note on note_access_requests (note_id);
create index if not exists idx_nar_requester on note_access_requests (requester_id);

-- Books (exercise sets) get the same visibility controls notes/files have.
-- Existing books default to is_public=false, access_mode='open' so nothing
-- already-created suddenly becomes visible to everyone; a facilitator has
-- to explicitly opt each book into public/team/reader visibility.
alter table books add column if not exists is_public boolean not null default false;
alter table books add column if not exists access_mode text not null default 'open';
alter table books drop constraint if exists books_access_mode_check;
alter table books add constraint books_access_mode_check check (access_mode in ('open', 'restricted'));
alter table books add column if not exists team_id bigint references teams(id) on delete set null;
alter table books add column if not exists theme_color text not null default '#2F6F4F';
alter table books add column if not exists passing_score integer not null default 60;
alter table books drop constraint if exists books_passing_score_check;
alter table books add constraint books_passing_score_check check (passing_score >= 0 and passing_score <= 100);

create index if not exists idx_books_public on books (is_public);
create index if not exists idx_books_team on books (team_id);

-- A book can now carry a cover photo (shown wherever the book/course is
-- listed) and one attached source document (e.g. the chapter/PDF the
-- exercises below are drawn from). Both live in the same "documents"
-- Storage bucket files already use; these columns just point at them.
-- Exercises themselves stay exactly as before — multiple-choice questions
-- with options, in the `questions` table above.
alter table books add column if not exists cover_storage_path text;
alter table books add column if not exists document_storage_path text;
alter table books add column if not exists document_original_name text;
alter table books add column if not exists document_mime_type text;
alter table books add column if not exists document_size_bytes bigint;

-- Book type: which parts of a book entry are active for learners.
-- 'book' = cover + attached document only, no practice questions shown;
-- 'exercises' = practice questions only, no cover/document section;
-- 'exercises_and_book' = both. Existing books default to
-- 'exercises_and_book' so nothing already-built changes behaviour.
alter table books add column if not exists book_type text not null default 'exercises_and_book';
alter table books drop constraint if exists books_book_type_check;
alter table books add constraint books_book_type_check check (book_type in ('book', 'exercises', 'exercises_and_book'));

-- Exercise "environment": the background a learner sees on the Exercises
-- page while practicing this book's questions. env_mode='default' uses the
-- site's normal graph-paper background; 'custom' paints env_bg_color behind
-- the question card with env_line_style ruled/grid lines (or none) on top.
alter table books add column if not exists env_mode text not null default 'default';
alter table books drop constraint if exists books_env_mode_check;
alter table books add constraint books_env_mode_check check (env_mode in ('default', 'custom'));
alter table books add column if not exists env_bg_color text not null default '#F6F5F1';
alter table books add column if not exists env_line_style text not null default 'none';
alter table books drop constraint if exists books_env_line_style_check;
alter table books add constraint books_env_line_style_check check (env_line_style in ('none', 'grid', 'ruled'));

create table if not exists book_access_requests (
  id            bigint generated always as identity primary key,
  book_id       bigint not null references books(id) on delete cascade,
  requester_id  bigint not null references users(id) on delete cascade,
  status        text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  created_at    timestamptz not null default now(),
  decided_at    timestamptz,
  unique (book_id, requester_id)
);

create index if not exists idx_bar_book on book_access_requests (book_id);
create index if not exists idx_bar_requester on book_access_requests (requester_id);

alter table notes enable row level security;
alter table note_access_requests enable row level security;
alter table book_access_requests enable row level security;

-- ============================================================
-- Share codes / QR access — lets a file owner or admin hand out a short
-- code (or a QR code that encodes a URL containing it) that grants one
-- specific private file to whoever redeems it, without making the file
-- public. Every redemption notifies the file owner and every admin via
-- the existing messages/toast system (see routes/files.js).
-- ============================================================

create table if not exists file_share_codes (
  id            bigint generated always as identity primary key,
  file_id       bigint references files(id) on delete cascade,
  code          text not null unique,
  created_by    bigint not null references users(id) on delete cascade,
  max_uses      integer,              -- null = unlimited
  use_count     integer not null default 0,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- file_id was originally "not null" (one code = one file). It's now
-- nullable so a code can instead cover several files via
-- file_share_code_files below — existing single-file codes are untouched.
alter table file_share_codes alter column file_id drop not null;
alter table file_share_codes add column if not exists expires_at timestamptz;

create index if not exists idx_fsc_file on file_share_codes (file_id);
create index if not exists idx_fsc_code on file_share_codes (code);

-- Bundle codes: one file_share_codes row (with file_id left null) can cover
-- many files via this join table, so one QR/code unlocks all of them at once.
create table if not exists file_share_code_files (
  id            bigint generated always as identity primary key,
  share_code_id bigint not null references file_share_codes(id) on delete cascade,
  file_id       bigint not null references files(id) on delete cascade,
  unique (share_code_id, file_id)
);
create index if not exists idx_fscf_share on file_share_code_files (share_code_id);
create index if not exists idx_fscf_file on file_share_code_files (file_id);

-- One row per (file, user) who redeemed a code — grants that user
-- standing access to the file (shows up under "Shared with me"), even
-- though the file itself stays private/unlisted otherwise.
create table if not exists file_share_access (
  id            bigint generated always as identity primary key,
  file_id       bigint not null references files(id) on delete cascade,
  share_code_id bigint references file_share_codes(id) on delete set null,
  user_id       bigint not null references users(id) on delete cascade,
  created_at    timestamptz not null default now(),
  unique (file_id, user_id)
);

create index if not exists idx_fsa_user on file_share_access (user_id);
create index if not exists idx_fsa_file on file_share_access (file_id);

alter table file_share_codes enable row level security;
alter table file_share_access enable row level security;
alter table file_share_code_files enable row level security;

-- ============================================================
-- Account-wide share codes / QR — like file_share_codes above, but grants
-- the redeemer standing read access to EVERY file the owner has (now and
-- anything they upload later), instead of just one file. Generated from
-- My Account ("Share my documents"). Revoking a code stops new
-- redemptions; revoking a specific viewer (account_share_access row) pulls
-- back access already granted.
-- ============================================================

create table if not exists account_share_codes (
  id            bigint generated always as identity primary key,
  owner_id      bigint not null references users(id) on delete cascade,
  code          text not null unique,
  max_uses      integer,              -- null = unlimited
  use_count     integer not null default 0,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

create index if not exists idx_asc_owner on account_share_codes (owner_id);
create index if not exists idx_asc_code on account_share_codes (code);

-- One row per (owner, viewer) who redeemed a code — viewer can see every
-- file owner has, forever, until the owner revokes this row.
create table if not exists account_share_access (
  id              bigint generated always as identity primary key,
  owner_id        bigint not null references users(id) on delete cascade,
  viewer_id       bigint not null references users(id) on delete cascade,
  share_code_id   bigint references account_share_codes(id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (owner_id, viewer_id)
);

create index if not exists idx_asa_owner on account_share_access (owner_id);
create index if not exists idx_asa_viewer on account_share_access (viewer_id);

alter table account_share_codes enable row level security;
alter table account_share_access enable row level security;

-- ============================================================
-- Screen sharing — lightweight WebRTC signaling. No websocket server is
-- required: host and viewer exchange SDP/ICE by polling this one row
-- (see routes/screenshare.js + public/js/screenshare.js). code is what
-- the "Share my screen" widget shows/starts; an admin joins from the
-- admin panel's "Screen share" tab, which polls list of waiting rows.
-- ============================================================

create table if not exists screen_share_sessions (
  id                bigint generated always as identity primary key,
  code              text not null unique,
  host_id           bigint not null references users(id) on delete cascade,
  viewer_id         bigint references users(id) on delete set null,
  status            text not null default 'waiting' check (status in ('waiting', 'connected', 'ended')),
  offer_sdp         text,
  answer_sdp        text,
  host_candidates   jsonb not null default '[]',
  viewer_candidates jsonb not null default '[]',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_sss_status on screen_share_sessions (status);
create index if not exists idx_sss_host on screen_share_sessions (host_id);

alter table screen_share_sessions enable row level security;

-- ============================================================
-- Note photo + attached document — same idea as book cover/document
-- above (same "documents" Storage bucket), so a note can show a card
-- image (e.g. on the home page and in the note list) and link to one
-- attached file.
-- ============================================================
alter table notes add column if not exists cover_storage_path text;
alter table notes add column if not exists document_storage_path text;
alter table notes add column if not exists document_original_name text;
alter table notes add column if not exists document_mime_type text;
alter table notes add column if not exists document_size_bytes bigint;

-- ============================================================
-- Short-answer questions — a second question type alongside the existing
-- MCQ one. A short-answer question has no options; the learner types a
-- free-text answer which is checked (loosely, after trimming/lowercasing/
-- stripping punctuation) against correct_answer_text, the "note" a
-- facilitator writes when creating the question.
-- ============================================================
alter table questions add column if not exists question_type text not null default 'mcq';
alter table questions drop constraint if exists questions_question_type_check;
alter table questions add constraint questions_question_type_check check (question_type in ('mcq', 'short_answer'));
alter table questions add column if not exists correct_answer_text text;
alter table questions alter column options drop not null;
alter table questions alter column options set default '[]'::jsonb;
alter table questions alter column correct_option_id drop not null;
