-- Dota 2 Replay Viewer: Anmeldung mit Teamname + Passwort und Admin-Bereich
-- In einer NEUEN, leeren Abfrage im Supabase SQL Editor einfügen und einmal ausführen.
-- VORHER in der markierten Zeile dein Admin-Passwort eintragen (mindestens 10 Zeichen).
-- Bestehende Teams behalten Namen, Passwort und Gegner.

begin;  -- alles oder nichts: bei einem Fehler bleibt die Datenbank unverändert

alter table public.drv_spaces add column if not exists salt text not null default '';
alter table public.drv_spaces add column if not exists is_admin boolean not null default false;
alter table public.drv_spaces drop constraint if exists drv_spaces_pass_hash_key;
create unique index if not exists drv_spaces_name_lower on public.drv_spaces (lower(name));

create or replace function public.drv_hash(p text) returns text
language sql immutable as $$
  select encode(sha256(convert_to(coalesce(p, ''), 'UTF8')), 'hex')
$$;

-- Admin-Zugang anlegen (Anmeldename: admin)
do $$
declare
  v_pass text := 'HIER-ADMIN-PASSWORT-EINTRAGEN';   -- <<< dein Admin-Passwort
  v_salt text := gen_random_uuid()::text;
begin
  if v_pass like 'HIER-%' or length(v_pass) < 10 then
    raise exception 'Bitte zuerst ein Admin-Passwort mit mindestens 10 Zeichen eintragen';
  end if;
  insert into public.drv_spaces (name, pass_hash, salt, is_admin)
  values ('admin', public.drv_hash(v_salt || v_pass), v_salt, true)
  on conflict (name) do update set pass_hash = excluded.pass_hash, salt = excluded.salt, is_admin = true;
end $$;

-- Alte Funktionen (nur Passwort) entfernen
drop function if exists public.drv_list(text);
drop function if exists public.drv_save(text, text, text, jsonb);
drop function if exists public.drv_delete(text, text);
drop function if exists public.drv_space(text);
drop function if exists public.drv_add_space(text, text);
drop function if exists public.drv_set_pass(text, text);

-- Anmeldung prüfen. Bei falschen Daten kurze Pause gegen Durchprobieren.
create or replace function public.drv_auth(p_login text, p_pass text) returns public.drv_spaces
language plpgsql security definer set search_path = public as $$
declare v drv_spaces;
begin
  select * into v from drv_spaces
  where lower(name) = lower(trim(coalesce(p_login, '')))
    and pass_hash = drv_hash(salt || coalesce(p_pass, ''));
  if not found then
    perform pg_sleep(0.5);
    raise exception 'Login falsch';
  end if;
  return v;
end $$;

-- Welcher Team-Bereich gilt? Teams: der eigene. Admin: das gewählte Team (oder keines).
create or replace function public.drv_space(p_login text, p_pass text, p_team text) returns bigint
language plpgsql security definer set search_path = public as $$
declare a drv_spaces := drv_auth(p_login, p_pass); v bigint;
begin
  if not a.is_admin then return a.id; end if;
  if p_team is null or trim(p_team) = '' then return null; end if;
  select id into v from drv_spaces where lower(name) = lower(trim(p_team)) and not is_admin;
  if v is null then raise exception 'Team nicht gefunden'; end if;
  return v;
end $$;

create or replace function public.drv_list(p_login text, p_pass text, p_team text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a drv_spaces := drv_auth(p_login, p_pass); v bigint := drv_space(p_login, p_pass, p_team);
begin
  return jsonb_build_object(
    'admin', a.is_admin,
    'space', (select name from drv_spaces where id = v),
    'opponents', coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'matches', matches) order by name)
      from drv_opponents where space_id = v), '[]'::jsonb));
end $$;

create or replace function public.drv_save(p_login text, p_pass text, p_team text, p_id text, p_name text, p_matches jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare v bigint := drv_space(p_login, p_pass, p_team);
begin
  if v is null then raise exception 'Bitte zuerst ein Team öffnen'; end if;
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

create or replace function public.drv_delete(p_login text, p_pass text, p_team text, p_id text) returns void
language plpgsql security definer set search_path = public as $$
declare v bigint := drv_space(p_login, p_pass, p_team);
begin
  if v is null then raise exception 'Bitte zuerst ein Team öffnen'; end if;
  delete from drv_opponents where id = p_id and space_id = v;
end $$;

-- ---------- Verwaltung (nur Admin) ----------
create or replace function public.drv_admin(p_login text, p_pass text) returns void
language plpgsql security definer set search_path = public as $$
declare a drv_spaces := drv_auth(p_login, p_pass);
begin
  if not a.is_admin then raise exception 'Nur für Admins'; end if;
end $$;

create or replace function public.drv_admin_list(p_login text, p_pass text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform drv_admin(p_login, p_pass);
  return coalesce((
    select jsonb_agg(jsonb_build_object('name', s.name, 'created_at', s.created_at,
      'opponents', (select count(*) from drv_opponents o where o.space_id = s.id)) order by lower(s.name))
    from drv_spaces s where not s.is_admin), '[]'::jsonb);
end $$;

create or replace function public.drv_admin_create(p_login text, p_pass text, p_name text, p_new_pass text) returns void
language plpgsql security definer set search_path = public as $$
declare v_name text := trim(coalesce(p_name, '')); v_salt text := gen_random_uuid()::text;
begin
  perform drv_admin(p_login, p_pass);
  if length(v_name) not between 1 and 40 then raise exception 'Teamname muss 1 bis 40 Zeichen haben'; end if;
  if length(coalesce(p_new_pass, '')) < 8 then raise exception 'Passwort muss mindestens 8 Zeichen haben'; end if;
  if exists (select 1 from drv_spaces where lower(name) = lower(v_name)) then
    raise exception 'Diesen Teamnamen gibt es schon';
  end if;
  insert into drv_spaces (name, pass_hash, salt) values (v_name, drv_hash(v_salt || p_new_pass), v_salt);
end $$;

create or replace function public.drv_admin_rename(p_login text, p_pass text, p_name text, p_new_name text) returns void
language plpgsql security definer set search_path = public as $$
declare v_name text := trim(coalesce(p_new_name, ''));
begin
  perform drv_admin(p_login, p_pass);
  if length(v_name) not between 1 and 40 then raise exception 'Teamname muss 1 bis 40 Zeichen haben'; end if;
  if exists (select 1 from drv_spaces where lower(name) = lower(v_name) and lower(name) <> lower(trim(p_name))) then
    raise exception 'Diesen Teamnamen gibt es schon';
  end if;
  update drv_spaces set name = v_name where lower(name) = lower(trim(p_name)) and not is_admin;
  if not found then raise exception 'Team nicht gefunden'; end if;
end $$;

-- Passwort eines Teams setzen; mit dem eigenen Namen ändert der Admin sein eigenes.
create or replace function public.drv_admin_set_pass(p_login text, p_pass text, p_name text, p_new_pass text) returns void
language plpgsql security definer set search_path = public as $$
declare v_salt text := gen_random_uuid()::text;
begin
  perform drv_admin(p_login, p_pass);
  if length(coalesce(p_new_pass, '')) < 8 then raise exception 'Passwort muss mindestens 8 Zeichen haben'; end if;
  update drv_spaces set salt = v_salt, pass_hash = drv_hash(v_salt || p_new_pass)
  where lower(name) = lower(trim(p_name));
  if not found then raise exception 'Team nicht gefunden'; end if;
end $$;

create or replace function public.drv_admin_delete(p_login text, p_pass text, p_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform drv_admin(p_login, p_pass);
  delete from drv_spaces where lower(name) = lower(trim(p_name)) and not is_admin;
  if not found then raise exception 'Team nicht gefunden'; end if;
end $$;

-- Rechte: interne Funktionen sind von außen gesperrt.
revoke all on function public.drv_hash(text) from public, anon, authenticated;
revoke all on function public.drv_auth(text, text) from public, anon, authenticated;
revoke all on function public.drv_space(text, text, text) from public, anon, authenticated;
revoke all on function public.drv_admin(text, text) from public, anon, authenticated;

revoke all on function public.drv_list(text, text, text) from public;
revoke all on function public.drv_save(text, text, text, text, text, jsonb) from public;
revoke all on function public.drv_delete(text, text, text, text) from public;
revoke all on function public.drv_admin_list(text, text) from public;
revoke all on function public.drv_admin_create(text, text, text, text) from public;
revoke all on function public.drv_admin_rename(text, text, text, text) from public;
revoke all on function public.drv_admin_set_pass(text, text, text, text) from public;
revoke all on function public.drv_admin_delete(text, text, text) from public;

grant execute on function public.drv_list(text, text, text) to anon, authenticated;
grant execute on function public.drv_save(text, text, text, text, text, jsonb) to anon, authenticated;
grant execute on function public.drv_delete(text, text, text, text) to anon, authenticated;
grant execute on function public.drv_admin_list(text, text) to anon, authenticated;
grant execute on function public.drv_admin_create(text, text, text, text) to anon, authenticated;
grant execute on function public.drv_admin_rename(text, text, text, text) to anon, authenticated;
grant execute on function public.drv_admin_set_pass(text, text, text, text) to anon, authenticated;
grant execute on function public.drv_admin_delete(text, text, text) to anon, authenticated;

commit;
