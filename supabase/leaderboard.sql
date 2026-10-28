-- Таблица лидеров «Чёрного неба».
-- Выполнить один раз: Supabase → SQL Editor → New query → вставить → Run.
--
-- Игра обращается к таблице с публичным ключом проекта, который виден в коде
-- страницы. Поэтому всё, что разрешено, задаётся здесь: читать и добавлять
-- может кто угодно, изменять и удалять — никто. Ограничения ниже отсекают
-- невозможные значения, но не защищают от правдоподобной подделки: результат
-- считается в браузере игрока.

create table if not exists public.scores (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  name        text     not null check (char_length(btrim(name)) between 1 and 24 and name !~ '[[:cntrl:]]'),
  scenario    text     not null check (scenario in ('evenkia', 'boguchany', 'minusinsk', 'emelyanovo')),
  burned      integer  not null check (burned between 0 and 20000000),
  grade       text     not null check (grade in ('none', 'bronze', 'silver', 'gold')),
  days        smallint not null check (days between 1 and 169),
  districts   smallint not null check (districts between 1 and 39),
  evolutions  smallint not null check (evolutions between 0 and 17),
  version     text     not null check (char_length(version) between 1 and 16),
  -- ранг обязан соответствовать площади: те же пороги, что в игре
  constraint grade_matches_burned check (
       (grade = 'gold'   and burned >= 5900000)
    or (grade = 'silver' and burned >= 2600000 and burned < 5900000)
    or (grade = 'bronze' and burned >= 500000  and burned < 2600000)
    or (grade = 'none'   and burned < 500000))
);

create index if not exists scores_top_idx on public.scores (burned desc, created_at);
create index if not exists scores_scenario_top_idx on public.scores (scenario, burned desc, created_at);

alter table public.scores enable row level security;

drop policy if exists "scores: read for everyone" on public.scores;
create policy "scores: read for everyone" on public.scores
  for select to anon, authenticated using (true);

drop policy if exists "scores: insert for everyone" on public.scores;
create policy "scores: insert for everyone" on public.scores
  for insert to anon, authenticated with check (true);

-- Политик на update/delete нет, значит при включённом RLS они запрещены.
grant select, insert on public.scores to anon, authenticated;

-- Простая защита от заливки: не больше 30 записей в минуту на всю таблицу.
create or replace function public.scores_rate_limit() returns trigger
language plpgsql as $$
begin
  if (select count(*) from public.scores where created_at > now() - interval '1 minute') >= 30 then
    raise exception 'too many submissions, try again later' using errcode = 'PT429';  -- PostgREST отдаёт это как HTTP 429
  end if;
  return new;
end $$;

drop trigger if exists scores_rate_limit on public.scores;
create trigger scores_rate_limit before insert on public.scores
  for each row execute function public.scores_rate_limit();
