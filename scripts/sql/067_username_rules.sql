-- Username rules, Telegram-style, enforced server-side.
--
-- Before this, the only rules were the original CHECK constraints (3-24
-- chars, [a-zA-Z0-9_.]) — nothing stopped an offensive or impersonating
-- username, and usernames couldn't be changed after sign-up at all.
--
-- New rules, applied ONLY when a username is created or changed (a trigger,
-- not a CHECK constraint, so existing accounts like the 3-char admin "Bek"
-- are grandfathered — a CHECK would re-validate on every unrelated UPDATE of
-- the row, e.g. last_seen_at, and break those accounts outright):
--   - 4-24 chars, starts with a letter, letters/digits/_/. only, no
--     doubled or trailing separator
--   - not reserved/impersonating (admin, support, official, televo*, ...)
--   - not offensive — English, Russian transliteration ("huy", "blyat"),
--     visual look-alikes ("cyka" = сука), leetspeak ("sh1t"), stretched
--     letters ("fuuuck"), and Russian typed on an English keyboard layout
--     ("gbplf" = пизда, "cerf" = сука)
--
-- check_username() exposes the same verdict to the client (including
-- "taken") so the sign-up and edit-profile screens can explain the problem
-- live, before submitting.

create or replace function public.username_problem(p_username text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  raw text := lower(coalesce(p_username, ''));
  base text;
  leet text;
  leet_c text;
  translit text;
  visual_c text;
  layout text;
  layout_c text;
  root text;
  latin_roots text[] := array[
    -- English
    'fuck','fck','shit','bitch','biatch','cunt','nigger','nigga','faggot',
    'whore','slut','pussy','pusy','asshole','ashole','dickhead','cocksuck',
    'motherf','porn','penis','vagina','retard','hitler','wanker','dildo','jizz',
    -- Russian, transliterated
    'huy','hui','huj','huesos','huila','nahuy','nahui','pohuy','pohui',
    'pizd','pezd','pisd','blyat','blyad','blya','bliat','suka','syka','cyka',
    'mudak','mudil','pidor','pidar','pidr','pedik','gandon','zalup',
    'dolboeb','dolbaeb','dolboyob','dolbayob','dolbaep','dolboep',
    'eblan','yeban','yebat','yebal','yoban','ebalo','uebok','uyeb',
    'shluh','shlyuh','govno','gavno','zhopa','jopa','yopa','chmo','mraz'
  ];
  cyr_roots text[] := array[
    'хуй','хуи','хуе','хуя','хую','наху','поху','пизд','пезд',
    'ебат','ебан','ебал','ебл','ебу','уеб','выеб','заеб',
    'бля','сука','суки','сучк','сучар','муда','муди','мудо',
    'пидор','пидар','пидр','педик','гандо','залуп','долбо','долба',
    'шлюх','говн','жоп','чмо','мраз'
  ];
  reserved_exact text[] := array[
    'admin','admins','administrator','root','system','sysadmin','support',
    'help','helpdesk','info','contact','official','moderator','moderators',
    'mod','mods','staff','team','security','safety','abuse','report','reports',
    'billing','payments','telegram','whatsapp','signal','viber','apple',
    'google','android','iphone','instagram','facebook','meta','twitter',
    'claude','anthropic','openai','chatgpt','bot','bots','assistant',
    'deleted','null','undefined','none','unknown','anonymous','everyone',
    'all','here','channel','news','verified','verify','api','www','mail',
    'email','settings','account','login','signup','register','password',
    'user','username'
  ];
begin
  if char_length(raw) < 4 then return 'too_short'; end if;
  if char_length(raw) > 24 then return 'too_long'; end if;
  if raw !~ '^[a-z0-9_.]+$' then return 'invalid_chars'; end if;
  if raw !~ '^[a-z]' then return 'must_start_with_letter'; end if;
  if raw ~ '[._]{2,}' or raw ~ '[._]$' then return 'bad_separators'; end if;

  base := regexp_replace(raw, '[._]', '', 'g');

  -- Reserved / impersonation.
  if base = any(reserved_exact)
     or base like '%televo%'
     or base like '%official%'
     or base like '%moderator%'
     or base like '%verified%'
     or base like 'admin%' or base like '%admin'
     or base like 'support%' or base like '%support'
     or raw like 'deleted%' or raw like 'del\_%' then
    return 'reserved';
  end if;

  -- Normalised variants of the same name. Each catches a different evasion.
  leet := translate(base, '0134578', 'oieastb');
  leet_c := regexp_replace(leet, '(.)\1+', '\1', 'g');
  translit := translate(leet_c, 'xjwq', 'hyvk');
  visual_c := regexp_replace(
    translate(base, 'aceopxykmhtbunr6340', 'асеорхукмнтвипгбзчо'),
    '(.)\1+', '\1', 'g');
  layout := translate(
    replace(raw, '_', ''),
    'qwertyuiopasdfghjklzxcvbnm.',
    'йцукенгшщзфывапролдячсмитью');
  layout_c := regexp_replace(layout, '(.)\1+', '\1', 'g');

  foreach root in array latin_roots loop
    if position(root in leet) > 0
       or position(root in leet_c) > 0
       or position(root in translit) > 0 then
      return 'offensive';
    end if;
  end loop;

  foreach root in array cyr_roots loop
    if position(root in layout) > 0
       or position(root in layout_c) > 0
       or position(root in visual_c) > 0 then
      return 'offensive';
    end if;
  end loop;

  return null;
end;
$$;

revoke execute on function public.username_problem(text) from public, anon, authenticated;

-- Client-facing: the same verdict plus "taken". Callable before sign-in so
-- the sign-up screen can check live; usernames are public identifiers (like
-- Telegram's), so "is this taken" leaks nothing that isn't already findable.
create or replace function public.check_username(p_username text)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_problem text;
begin
  v_problem := public.username_problem(p_username);
  if v_problem is not null then
    return v_problem;
  end if;
  if exists (
    select 1 from public.profiles
     where username = p_username::citext
       and id is distinct from auth.uid()
  ) then
    return 'taken';
  end if;
  return null;
end;
$$;

revoke execute on function public.check_username(text) from public;
grant execute on function public.check_username(text) to anon, authenticated;

create or replace function public.enforce_username_rules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_problem text;
begin
  -- delete_own_account() writes a system placeholder that is deliberately
  -- reserved for everyone else.
  if new.is_deleted then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.username is not distinct from old.username then
    return new;
  end if;

  v_problem := public.username_problem(new.username);
  if v_problem is not null then
    raise exception 'username_%', v_problem
      using errcode = 'check_violation',
            hint = 'Choose a different username.';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_username_rules on public.profiles;
create trigger enforce_username_rules
  before insert or update of username on public.profiles
  for each row execute function public.enforce_username_rules();

-- Fix for 065: its placeholder was 'deleted_' + 32 hex chars = 40 chars,
-- over the profiles_username length CHECK (max 24), so every account
-- deletion raised a check_violation and rolled back. 'del_' + 20 hex chars
-- is exactly 24 and still unique per account (80 bits).
create or replace function public.delete_own_account()
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  update public.profiles
     set is_deleted = true,
         display_name = 'Deleted Account',
         username = 'del_' || left(replace(v_uid::text, '-', ''), 20),
         bio = null,
         avatar_url = null,
         phone = null,
         e2e_public_key = null,
         e2e_kyber_public_key = null,
         updated_at = now()
   where id = v_uid;

  update auth.users
     set banned_until = 'infinity'::timestamptz
   where id = v_uid;

  delete from public.push_tokens where user_id = v_uid;
  delete from public.voip_push_tokens where user_id = v_uid;
  delete from auth.sessions where user_id = v_uid;
end;
$$;

revoke execute on function public.delete_own_account() from anon, public;
grant execute on function public.delete_own_account() to authenticated;
