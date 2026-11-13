-- Dota 2 Replay Viewer: gemeinsame Gegner-Datenbank
-- Im Supabase-Projekt unter "SQL Editor" einfügen und einmal ausführen.
-- VORHER in der markierten Zeile das gemeinsame Passwort eintragen.

create table if not exists public.drv_opponents (
  id text primary key,
  name text not null,
  matches jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.drv_opponents enable row level security;

-- Lesen darf jeder Besucher. Schreiben geht nur über die Funktionen unten.
drop policy if exists "drv lesen" on public.drv_opponents;
create policy "drv lesen" on public.drv_opponents for select to anon, authenticated using (true);

-- Ablage für das Passwort (nur als Prüfsumme). Ohne Policy ist die Tabelle von außen nicht lesbar.
create table if not exists public.drv_config (key text primary key, value text not null);
alter table public.drv_config enable row level security;

insert into public.drv_config (key, value)
values ('pass_hash', encode(sha256(convert_to(
  'HIER-PASSWORT-EINTRAGEN'      -- <<< gemeinsames Passwort zum Bearbeiten
, 'UTF8')), 'hex'))
on conflict (key) do update set value = excluded.value;

create or replace function public.drv_check(p_pass text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from drv_config
    where key = 'pass_hash'
      and value = encode(sha256(convert_to(coalesce(p_pass, ''), 'UTF8')), 'hex')
  ) then
    raise exception 'Passwort falsch';
  end if;
end $$;

create or replace function public.drv_save(p_pass text, p_id text, p_name text, p_matches jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform drv_check(p_pass);
  if p_id is null or length(p_id) not between 1 and 40
     or p_name is null or length(p_name) not between 1 and 80
     or jsonb_typeof(p_matches) <> 'array' or jsonb_array_length(p_matches) > 500 then
    raise exception 'Ungültige Daten';
  end if;
  insert into drv_opponents (id, name, matches) values (p_id, p_name, p_matches)
  on conflict (id) do update set name = excluded.name, matches = excluded.matches, updated_at = now();
end $$;

create or replace function public.drv_delete(p_pass text, p_id text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform drv_check(p_pass);
  delete from drv_opponents where id = p_id;
end $$;

revoke all on function public.drv_check(text) from public, anon, authenticated;
revoke all on function public.drv_save(text, text, text, jsonb) from public;
revoke all on function public.drv_delete(text, text) from public;
grant execute on function public.drv_save(text, text, text, jsonb) to anon, authenticated;
grant execute on function public.drv_delete(text, text) to anon, authenticated;
