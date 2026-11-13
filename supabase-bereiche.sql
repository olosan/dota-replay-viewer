-- Dota 2 Replay Viewer: Umstellung auf Team-Bereiche
-- Im Supabase-Projekt unter "SQL Editor" einfügen und EINMAL ausführen.
-- Hier muss nichts angepasst werden. Der bisherige Bereich behält sein Passwort und seine Gegner.

begin;  -- alles oder nichts: bei einem Fehler bleibt die Datenbank unverändert

create table if not exists public.drv_spaces (
  id bigint generated always as identity primary key,
  name text not null unique,
  pass_hash text not null unique,
  created_at timestamptz not null default now()
);
alter table public.drv_spaces enable row level security;  -- keine Policy: von außen nicht lesbar

-- Der bisherige Bereich übernimmt das bisherige Passwort.
insert into public.drv_spaces (name, pass_hash)
select 'Hauptbereich', value from public.drv_config where key = 'pass_hash'
on conflict do nothing;

alter table public.drv_opponents
  add column if not exists space_id bigint references public.drv_spaces(id) on delete cascade;
update public.drv_opponents
  set space_id = (select id from public.drv_spaces order by id limit 1)
  where space_id is null;
alter table public.drv_opponents alter column space_id set not null;

-- Ab jetzt kann niemand mehr ohne Passwort lesen.
drop policy if exists "drv lesen" on public.drv_opponents;

create or replace function public.drv_hash(p text) returns text
language sql immutable as $$
  select encode(sha256(convert_to(coalesce(p, ''), 'UTF8')), 'hex')
$$;

-- Passwort -> Bereich. Falsches Passwort bricht ab.
create or replace function public.drv_space(p_pass text) returns bigint
language plpgsql security definer set search_path = public as $$
declare v bigint;
begin
  select id into v from drv_spaces where pass_hash = drv_hash(p_pass);
  if v is null then raise exception 'Passwort falsch'; end if;
  return v;
end $$;

create or replace function public.drv_list(p_pass text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v bigint := drv_space(p_pass);
begin
  return jsonb_build_object(
    'space', (select name from drv_spaces where id = v),
    'opponents', coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'matches', matches) order by name)
      from drv_opponents where space_id = v), '[]'::jsonb));
end $$;

create or replace function public.drv_save(p_pass text, p_id text, p_name text, p_matches jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare v bigint := drv_space(p_pass);
begin
  if p_id is null or length(p_id) not between 1 and 40
     or p_name is null or length(p_name) not between 1 and 80
     or jsonb_typeof(p_matches) <> 'array' or jsonb_array_length(p_matches) > 500 then
    raise exception 'Ungültige Daten';
  end if;
  insert into drv_opponents (id, name, matches, space_id) values (p_id, p_name, p_matches, v)
  on conflict (id) do update set name = excluded.name, matches = excluded.matches, updated_at = now()
    where drv_opponents.space_id = v;
  if not found then raise exception 'Ungültige Daten'; end if;
end $$;

create or replace function public.drv_delete(p_pass text, p_id text) returns void
language plpgsql security definer set search_path = public as $$
declare v bigint := drv_space(p_pass);
begin
  delete from drv_opponents where id = p_id and space_id = v;
end $$;

-- Verwaltung: nur im SQL Editor aufrufbar, nicht von der Webseite.
create or replace function public.drv_add_space(p_name text, p_pass text) returns text
language plpgsql security definer set search_path = public as $$
begin
  if length(coalesce(p_pass, '')) < 8 then raise exception 'Passwort muss mindestens 8 Zeichen haben'; end if;
  insert into drv_spaces (name, pass_hash) values (p_name, drv_hash(p_pass));
  return 'Bereich "' || p_name || '" angelegt';
end $$;

create or replace function public.drv_set_pass(p_name text, p_pass text) returns text
language plpgsql security definer set search_path = public as $$
begin
  if length(coalesce(p_pass, '')) < 8 then raise exception 'Passwort muss mindestens 8 Zeichen haben'; end if;
  update drv_spaces set pass_hash = drv_hash(p_pass) where name = p_name;
  if not found then raise exception 'Bereich nicht gefunden'; end if;
  return 'Passwort für "' || p_name || '" geändert';
end $$;

drop function if exists public.drv_check(text);

revoke all on function public.drv_hash(text) from public, anon, authenticated;
revoke all on function public.drv_space(text) from public, anon, authenticated;
revoke all on function public.drv_add_space(text, text) from public, anon, authenticated;
revoke all on function public.drv_set_pass(text, text) from public, anon, authenticated;
revoke all on function public.drv_list(text) from public;
revoke all on function public.drv_save(text, text, text, jsonb) from public;
revoke all on function public.drv_delete(text, text) from public;
grant execute on function public.drv_list(text) to anon, authenticated;
grant execute on function public.drv_save(text, text, text, jsonb) to anon, authenticated;
grant execute on function public.drv_delete(text, text) to anon, authenticated;

commit;

-- ---------------------------------------------------------------------------
-- SPÄTER, jeweils einzeln im SQL Editor ausführen (ohne die zwei Striche davor):
--
-- Neuen Team-Bereich anlegen:
--   select public.drv_add_space('Teamname', 'passwort-fuer-dieses-team');
--
-- Bereich umbenennen:
--   update public.drv_spaces set name = 'Neuer Name' where name = 'Hauptbereich';
--
-- Passwort eines Bereichs ändern:
--   select public.drv_set_pass('Teamname', 'neues-passwort');
--
-- Alle Bereiche anzeigen:
--   select id, name, created_at from public.drv_spaces order by id;
