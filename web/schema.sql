-- Run this in your Supabase project's SQL editor. See README.md for the full
-- setup walkthrough. The whole file is safe to run again (every create is
-- "if not exists", and each policy is dropped before it's re-created), so on an
-- existing project you can simply run all of it to pick up newer blocks.

create table if not exists cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) default auth.uid(),
  lemma text not null,
  surface text not null,
  sentence text not null,
  target_start int not null,
  definitions jsonb not null default '[]',   -- CardDefinition[] from the extension, as-is
  url text not null,
  title text not null,
  created_at timestamptz not null default now(),

  -- ts-fsrs Card fields (see createEmptyCard() in the ts-fsrs package) --
  due timestamptz not null default now(),
  stability double precision not null default 0,
  difficulty double precision not null default 0,
  elapsed_days int not null default 0,
  scheduled_days int not null default 0,
  reps int not null default 0,
  lapses int not null default 0,
  state int not null default 0,              -- ts-fsrs State enum (New=0, Learning=1, Review=2, Relearning=3)
  last_review timestamptz,

  -- Storage paths (bucket card-media, see below) of a YouTube card's audio clip and
  -- video frame, uploaded by the extension. Null for cards without media.
  audio_path text,
  frame_path text
);

alter table cards enable row level security;

drop policy if exists "own cards" on cards;
create policy "own cards" on cards for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists cards_due_idx on cards (user_id, due);

-- ---- Card media (audio clip + video frame) ----------------------------------
-- Run this block in the SQL editor too. Already have a `cards` table from
-- before this existed? The first two lines add the missing columns to it (a
-- fresh install already has them from the create table above, so they're no-ops).
alter table cards add column if not exists audio_path text;
alter table cards add column if not exists frame_path text;

-- A PRIVATE bucket: files are only readable with the owner's login, never by URL.
insert into storage.buckets (id, name, public) values ('card-media', 'card-media', false)
  on conflict (id) do nothing;

-- Each user may only touch files under a folder named after their own user id
-- ({user id}/{card id}/audio.webm), which is how the extension lays them out.
drop policy if exists "own media read" on storage.objects;
create policy "own media read" on storage.objects for select to authenticated
  using (bucket_id = 'card-media' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "own media insert" on storage.objects;
create policy "own media insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'card-media' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "own media update" on storage.objects;
create policy "own media update" on storage.objects for update to authenticated
  using (bucket_id = 'card-media' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'card-media' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "own media delete" on storage.objects;
create policy "own media delete" on storage.objects for delete to authenticated
  using (bucket_id = 'card-media' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---- Vocabulary, review history, and the website's paste-text reader ----------
-- Run this block in the SQL editor too. It adds four small tables:
--   vocab        one row per user: the extension's whole word->status map, uploaded
--                on 모두 동기화 (the reader and the stats read it)
--   vocab_inbox  word marks made on the website, waiting for the extension to apply
--                them on its next 모두 동기화 (then it deletes them)
--   vocab_daily  one row per user per day: how many words are known/seen/learning
--                (the growth chart)
--   review_log   one row per card rating (the activity heatmap)
create table if not exists vocab (
  user_id uuid primary key references auth.users(id) default auth.uid(),
  words jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
create table if not exists vocab_inbox (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) default auth.uid(),
  lemma text not null,
  status text not null,
  created_at timestamptz not null default now()
);
create table if not exists vocab_daily (
  user_id uuid not null references auth.users(id) default auth.uid(),
  day date not null,
  known int not null default 0,
  seen int not null default 0,
  learning int not null default 0,
  primary key (user_id, day)
);
create table if not exists review_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) default auth.uid(),
  card_id uuid,
  rating int not null,
  reviewed_at timestamptz not null default now()
);
create index if not exists review_log_user_time on review_log (user_id, reviewed_at);

alter table vocab enable row level security;
alter table vocab_inbox enable row level security;
alter table vocab_daily enable row level security;
alter table review_log enable row level security;
drop policy if exists "own vocab" on vocab;
create policy "own vocab" on vocab for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own vocab inbox" on vocab_inbox;
create policy "own vocab inbox" on vocab_inbox for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own vocab daily" on vocab_daily;
create policy "own vocab daily" on vocab_daily for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own review log" on review_log;
create policy "own review log" on review_log for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---- "Seen it again" counts ---------------------------------------------------
-- Run this block in the SQL editor too (after the vocabulary block above; safe
-- to run more than once). Until it's run, the extension's 모두 동기화 just
-- skips uploading the counts (the words still sync) and the website shows no
-- "다시 만남" chip. Holds only lemma -> count; the pages a word was seen on
-- never leave the extension (it keeps short hashes of them locally).
alter table vocab add column if not exists encounters jsonb not null default '{}';
