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
