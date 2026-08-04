begin;

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public;

create table if not exists public.settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.admin_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  role text not null default 'admin' check (role in ('owner', 'admin')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  full_name text not null check (char_length(trim(full_name)) between 2 and 120),
  mobile text not null check (mobile ~ '^09[0-9]{9}$'),
  facebook_url text not null default '',
  court_id text not null default 'court-1',
  booking_date date not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  start_hour smallint not null check (start_hour between 0 and 23),
  end_hour smallint not null check (end_hour between 1 and 24),
  duration_hours smallint not null check (duration_hours between 1 and 7),
  hourly_rate integer not null default 250 check (hourly_rate > 0),
  estimated_total integer not null check (estimated_total >= 0),
  status text not null default 'pending'
    check (status in ('pending', 'confirmed', 'completed', 'cancelled', 'rejected')),
  payment_arrangement text not null default 'Pay at venue after playing',
  payment_status text not null default 'pay_at_venue'
    check (payment_status in ('pay_at_venue', 'paid')),
  submitted_at timestamptz not null default now(),
  confirmed_at timestamptz,
  rejected_at timestamptz,
  cancelled_at timestamptz,
  completed_at timestamptz,
  paid_at timestamptz,
  reason text,
  internal_notes text,
  action_admin_id uuid references public.admin_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bookings_time_order check (end_at > start_at),
  constraint bookings_hour_order check (end_hour > start_hour),
  constraint bookings_duration_matches_hours check (duration_hours = end_hour - start_hour),
  constraint bookings_total_matches_rate check (estimated_total = duration_hours * hourly_rate)
);

create table if not exists public.booking_slots (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  court_id text not null default 'court-1',
  slot_date date not null,
  slot_hour smallint not null check (slot_hour between 0 and 23),
  start_at timestamptz not null,
  status text not null check (status in ('pending', 'confirmed', 'completed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.availability (
  id uuid primary key default gen_random_uuid(),
  court_id text not null default 'court-1',
  slot_date date not null,
  slot_hour smallint not null check (slot_hour between 0 and 23),
  start_at timestamptz not null,
  status text not null check (status in ('available', 'unavailable')),
  reason text,
  admin_id uuid references public.admin_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (court_id, start_at)
);

create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid references public.admin_profiles(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text not null,
  old_value jsonb,
  new_value jsonb,
  reason text,
  created_at timestamptz not null default now()
);

create table if not exists public.notification_log (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  event text not null,
  status text not null check (status in ('pending', 'sent', 'failed')),
  error text,
  created_at timestamptz not null default now()
);

create table if not exists public.daily_sheet_sync (
  booking_date date primary key,
  total_bookings integer not null default 0 check (total_bookings >= 0),
  total_booked_hours integer not null default 0 check (total_booked_hours >= 0),
  total_revenue integer not null default 0 check (total_revenue >= 0),
  updated_at timestamptz not null default now(),
  synced_at timestamptz,
  last_attempt_at timestamptz,
  last_error text
);

create unique index if not exists booking_slots_active_court_start_unique
  on public.booking_slots (court_id, start_at)
  where status in ('pending', 'confirmed');

create index if not exists bookings_date_status_idx
  on public.bookings (booking_date, status);

create index if not exists bookings_status_start_idx
  on public.bookings (status, start_at);

create index if not exists bookings_mobile_submitted_idx
  on public.bookings (mobile, submitted_at desc);

create index if not exists booking_slots_booking_idx
  on public.booking_slots (booking_id);

create index if not exists booking_slots_date_hour_idx
  on public.booking_slots (slot_date, slot_hour);

create index if not exists availability_date_hour_idx
  on public.availability (slot_date, slot_hour);

create index if not exists audit_log_created_idx
  on public.audit_log (created_at desc);

create index if not exists notification_log_booking_idx
  on public.notification_log (booking_id, created_at desc);

create index if not exists daily_sheet_sync_pending_idx
  on public.daily_sheet_sync (synced_at, booking_date);

insert into public.settings (key, value)
values
  ('hourly_rate', '250'),
  ('opening_hour', '16'),
  ('closing_hour', '23'),
  ('timezone', 'Asia/Manila')
on conflict (key) do nothing;

create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.admin_profiles
    where id = (select auth.uid())
      and active = true
  );
$$;

revoke all on function private.is_admin() from public;
grant execute on function private.is_admin() to authenticated, service_role;

create or replace function private.promote_admin(
  p_email text,
  p_display_name text,
  p_role text default 'owner'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  if p_role not in ('owner', 'admin') then
    raise exception 'Role must be owner or admin.';
  end if;

  select id into v_user_id
  from auth.users
  where lower(email) = lower(trim(p_email))
  limit 1;

  if v_user_id is null then
    raise exception 'Create this email in Authentication > Users before promoting it.';
  end if;

  insert into public.admin_profiles (id, display_name, role, active)
  values (v_user_id, trim(p_display_name), p_role, true)
  on conflict (id) do update
  set display_name = excluded.display_name,
      role = excluded.role,
      active = true,
      updated_at = now();

  return v_user_id;
end;
$$;

revoke all on function private.promote_admin(text, text, text) from public, anon, authenticated;

create or replace function private.set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists settings_set_updated_at on public.settings;
create trigger settings_set_updated_at
before update on public.settings
for each row execute function private.set_updated_at();

drop trigger if exists admin_profiles_set_updated_at on public.admin_profiles;
create trigger admin_profiles_set_updated_at
before update on public.admin_profiles
for each row execute function private.set_updated_at();

drop trigger if exists bookings_set_updated_at on public.bookings;
create trigger bookings_set_updated_at
before update on public.bookings
for each row execute function private.set_updated_at();

drop trigger if exists booking_slots_set_updated_at on public.booking_slots;
create trigger booking_slots_set_updated_at
before update on public.booking_slots
for each row execute function private.set_updated_at();

drop trigger if exists availability_set_updated_at on public.availability;
create trigger availability_set_updated_at
before update on public.availability
for each row execute function private.set_updated_at();

create or replace function public.create_booking_request(
  p_full_name text,
  p_mobile text,
  p_facebook_url text,
  p_booking_date date,
  p_start_hour integer,
  p_end_hour integer
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking_id uuid := gen_random_uuid();
  v_rate integer;
  v_start_at timestamptz;
  v_end_at timestamptz;
  v_duration integer;
begin
  if trim(coalesce(p_full_name, '')) = '' then
    raise exception 'Customer name is required.';
  end if;

  if coalesce(p_mobile, '') !~ '^09[0-9]{9}$' then
    raise exception 'Enter an 11-digit Philippine mobile number beginning with 09.';
  end if;

  if p_booking_date < (now() at time zone 'Asia/Manila')::date then
    raise exception 'Past dates cannot be booked.';
  end if;

  if p_start_hour < 16 or p_end_hour > 23 or p_end_hour <= p_start_hour then
    raise exception 'Bookings must be consecutive hours between 4 PM and 11 PM.';
  end if;

  v_duration := p_end_hour - p_start_hour;
  select value::integer into v_rate
  from public.settings
  where key = 'hourly_rate';
  v_rate := coalesce(v_rate, 250);

  v_start_at := (
    p_booking_date::text || ' ' || lpad(p_start_hour::text, 2, '0') || ':00:00 Asia/Manila'
  )::timestamptz;
  v_end_at := (
    p_booking_date::text || ' ' || lpad(p_end_hour::text, 2, '0') || ':00:00 Asia/Manila'
  )::timestamptz;

  if v_start_at <= now() then
    raise exception 'This booking time has already passed.';
  end if;

  if exists (
    select 1
    from public.availability
    where court_id = 'court-1'
      and slot_date = p_booking_date
      and slot_hour >= p_start_hour
      and slot_hour < p_end_hour
      and status = 'unavailable'
  ) then
    raise exception 'One or more selected hours are unavailable.';
  end if;

  if exists (
    select 1
    from public.booking_slots
    where court_id = 'court-1'
      and slot_date = p_booking_date
      and slot_hour >= p_start_hour
      and slot_hour < p_end_hour
      and status in ('pending', 'confirmed')
  ) then
    raise exception 'One or more selected hours were already booked.';
  end if;

  insert into public.bookings (
    id,
    full_name,
    mobile,
    facebook_url,
    court_id,
    booking_date,
    start_at,
    end_at,
    start_hour,
    end_hour,
    duration_hours,
    hourly_rate,
    estimated_total,
    status
  ) values (
    v_booking_id,
    trim(p_full_name),
    p_mobile,
    coalesce(trim(p_facebook_url), ''),
    'court-1',
    p_booking_date,
    v_start_at,
    v_end_at,
    p_start_hour,
    p_end_hour,
    v_duration,
    v_rate,
    v_duration * v_rate,
    'pending'
  );

  insert into public.booking_slots (
    booking_id,
    court_id,
    slot_date,
    slot_hour,
    start_at,
    status
  )
  select
    v_booking_id,
    'court-1',
    p_booking_date,
    hour_value,
    (
      p_booking_date::text || ' ' || lpad(hour_value::text, 2, '0') || ':00:00 Asia/Manila'
    )::timestamptz,
    'pending'
  from generate_series(p_start_hour, p_end_hour - 1) as hour_value;

  return v_booking_id;
exception
  when unique_violation then
    raise exception 'One or more selected hours were already booked.';
end;
$$;

create or replace function public.confirm_booking(
  p_booking_id uuid,
  p_admin_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.bookings;
begin
  select * into v_old
  from public.bookings
  where id = p_booking_id
  for update;

  if not found then
    raise exception 'Booking not found.';
  end if;

  if v_old.status <> 'pending' then
    raise exception 'Only pending bookings can be confirmed.';
  end if;

  if v_old.start_at <= now() then
    raise exception 'This booking time has already passed.';
  end if;

  update public.bookings
  set status = 'confirmed',
      confirmed_at = now(),
      action_admin_id = p_admin_id
  where id = p_booking_id;

  update public.booking_slots
  set status = 'confirmed'
  where booking_id = p_booking_id;

  insert into public.audit_log (
    admin_id,
    action,
    entity_type,
    entity_id,
    old_value,
    new_value
  ) values (
    p_admin_id,
    'booking_confirmed',
    'booking',
    p_booking_id::text,
    to_jsonb(v_old),
    (select to_jsonb(b) from public.bookings b where b.id = p_booking_id)
  );
end;
$$;

create or replace function public.create_manual_booking(
  p_full_name text,
  p_mobile text,
  p_facebook_url text,
  p_booking_date date,
  p_start_hour integer,
  p_end_hour integer,
  p_admin_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking_id uuid;
begin
  v_booking_id := public.create_booking_request(
    p_full_name,
    p_mobile,
    p_facebook_url,
    p_booking_date,
    p_start_hour,
    p_end_hour
  );

  perform public.confirm_booking(v_booking_id, p_admin_id);

  insert into public.audit_log (
    admin_id,
    action,
    entity_type,
    entity_id,
    new_value
  ) values (
    p_admin_id,
    'manual_booking_created',
    'booking',
    v_booking_id::text,
    (select to_jsonb(b) from public.bookings b where b.id = v_booking_id)
  );

  return v_booking_id;
end;
$$;

create or replace function public.reschedule_booking(
  p_booking_id uuid,
  p_new_date date,
  p_new_start_hour integer,
  p_admin_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.bookings;
  v_new_end_hour integer;
  v_new_start_at timestamptz;
  v_new_end_at timestamptz;
begin
  select * into v_old
  from public.bookings
  where id = p_booking_id
  for update;

  if not found then
    raise exception 'Booking not found.';
  end if;

  if v_old.status not in ('pending', 'confirmed') then
    raise exception 'Only pending or confirmed bookings can be rescheduled.';
  end if;

  v_new_end_hour := p_new_start_hour + v_old.duration_hours;

  if p_new_start_hour < 16 or v_new_end_hour > 23 then
    raise exception 'The complete booking must fit between 4 PM and 11 PM.';
  end if;

  v_new_start_at := (
    p_new_date::text || ' ' || lpad(p_new_start_hour::text, 2, '0') || ':00:00 Asia/Manila'
  )::timestamptz;
  v_new_end_at := (
    p_new_date::text || ' ' || lpad(v_new_end_hour::text, 2, '0') || ':00:00 Asia/Manila'
  )::timestamptz;

  if v_new_start_at <= now() then
    raise exception 'The new booking time must be in the future.';
  end if;

  if exists (
    select 1
    from public.availability
    where court_id = v_old.court_id
      and slot_date = p_new_date
      and slot_hour >= p_new_start_hour
      and slot_hour < v_new_end_hour
      and status = 'unavailable'
  ) then
    raise exception 'One or more selected hours are unavailable.';
  end if;

  if exists (
    select 1
    from public.booking_slots
    where booking_id <> p_booking_id
      and court_id = v_old.court_id
      and slot_date = p_new_date
      and slot_hour >= p_new_start_hour
      and slot_hour < v_new_end_hour
      and status in ('pending', 'confirmed')
  ) then
    raise exception 'One or more selected hours were already booked.';
  end if;

  delete from public.booking_slots
  where booking_id = p_booking_id;

  update public.bookings
  set booking_date = p_new_date,
      start_at = v_new_start_at,
      end_at = v_new_end_at,
      start_hour = p_new_start_hour,
      end_hour = v_new_end_hour,
      action_admin_id = p_admin_id
  where id = p_booking_id;

  insert into public.booking_slots (
    booking_id,
    court_id,
    slot_date,
    slot_hour,
    start_at,
    status
  )
  select
    p_booking_id,
    v_old.court_id,
    p_new_date,
    hour_value,
    (
      p_new_date::text || ' ' || lpad(hour_value::text, 2, '0') || ':00:00 Asia/Manila'
    )::timestamptz,
    v_old.status
  from generate_series(p_new_start_hour, v_new_end_hour - 1) as hour_value;

  insert into public.audit_log (
    admin_id,
    action,
    entity_type,
    entity_id,
    old_value,
    new_value
  ) values (
    p_admin_id,
    'booking_rescheduled',
    'booking',
    p_booking_id::text,
    to_jsonb(v_old),
    (select to_jsonb(b) from public.bookings b where b.id = p_booking_id)
  );
exception
  when unique_violation then
    raise exception 'One or more selected hours were already booked.';
end;
$$;

create or replace function public.run_booking_maintenance()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.bookings
  set status = 'completed',
      completed_at = coalesce(completed_at, end_at),
      payment_status = 'paid',
      paid_at = coalesce(paid_at, end_at)
  where status = 'confirmed'
    and end_at <= now();

  update public.booking_slots as slots
  set status = 'completed'
  from public.bookings as bookings
  where slots.booking_id = bookings.id
    and bookings.status = 'completed'
    and slots.status <> 'completed';

  delete from public.bookings
  where status = 'pending'
    and start_at <= now();

  delete from public.audit_log
  where created_at < now() - interval '30 days';

  insert into public.daily_sheet_sync (
    booking_date,
    total_bookings,
    total_booked_hours,
    total_revenue,
    updated_at
  )
  select
    booking_date,
    count(*)::integer,
    coalesce(sum(duration_hours), 0)::integer,
    coalesce(sum(estimated_total), 0)::integer,
    now()
  from public.bookings
  where status = 'completed'
  group by booking_date
  on conflict (booking_date) do update
  set total_bookings = excluded.total_bookings,
      total_booked_hours = excluded.total_booked_hours,
      total_revenue = excluded.total_revenue,
      updated_at = excluded.updated_at,
      synced_at = null,
      last_error = null
  where public.daily_sheet_sync.total_bookings is distinct from excluded.total_bookings
     or public.daily_sheet_sync.total_booked_hours is distinct from excluded.total_booked_hours
     or public.daily_sheet_sync.total_revenue is distinct from excluded.total_revenue;
end;
$$;

create or replace view public.active_completed_bookings
with (security_invoker = true)
as
select *
from public.bookings
where status = 'completed'
  and coalesce(completed_at, end_at) >= now() - interval '7 days';

create or replace view public.daily_revenue_summary
with (security_invoker = true)
as
select
  booking_date,
  count(*)::integer as total_bookings,
  coalesce(sum(duration_hours), 0)::integer as total_booked_hours,
  coalesce(sum(estimated_total), 0)::integer as total_revenue
from public.bookings
where status = 'completed'
group by booking_date;

create or replace view public.monthly_revenue_summary
with (security_invoker = true)
as
select
  date_trunc('month', booking_date::timestamp)::date as month_start,
  count(*)::integer as total_bookings,
  coalesce(sum(duration_hours), 0)::integer as total_booked_hours,
  coalesce(sum(estimated_total), 0)::integer as total_revenue
from public.bookings
where status = 'completed'
group by date_trunc('month', booking_date::timestamp);

alter table public.settings enable row level security;
alter table public.admin_profiles enable row level security;
alter table public.bookings enable row level security;
alter table public.booking_slots enable row level security;
alter table public.availability enable row level security;
alter table public.audit_log enable row level security;
alter table public.notification_log enable row level security;
alter table public.daily_sheet_sync enable row level security;

drop policy if exists admin_settings_access on public.settings;
create policy admin_settings_access on public.settings
for all to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));

drop policy if exists admin_profiles_access on public.admin_profiles;
create policy admin_profiles_access on public.admin_profiles
for all to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));

drop policy if exists admin_bookings_access on public.bookings;
create policy admin_bookings_access on public.bookings
for all to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));

drop policy if exists admin_booking_slots_access on public.booking_slots;
create policy admin_booking_slots_access on public.booking_slots
for all to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));

drop policy if exists admin_availability_access on public.availability;
create policy admin_availability_access on public.availability
for all to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));

drop policy if exists admin_audit_log_access on public.audit_log;
create policy admin_audit_log_access on public.audit_log
for all to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));

drop policy if exists admin_notification_log_access on public.notification_log;
create policy admin_notification_log_access on public.notification_log
for all to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));

drop policy if exists admin_daily_sheet_sync_access on public.daily_sheet_sync;
create policy admin_daily_sheet_sync_access on public.daily_sheet_sync
for all to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));

revoke all on table public.settings from anon, authenticated;
revoke all on table public.admin_profiles from anon, authenticated;
revoke all on table public.bookings from anon, authenticated;
revoke all on table public.booking_slots from anon, authenticated;
revoke all on table public.availability from anon, authenticated;
revoke all on table public.audit_log from anon, authenticated;
revoke all on table public.notification_log from anon, authenticated;
revoke all on table public.daily_sheet_sync from anon, authenticated;

grant select, insert, update, delete on table public.settings to authenticated;
grant select, insert, update, delete on table public.admin_profiles to authenticated;
grant select, insert, update, delete on table public.bookings to authenticated;
grant select, insert, update, delete on table public.booking_slots to authenticated;
grant select, insert, update, delete on table public.availability to authenticated;
grant select, insert, update, delete on table public.audit_log to authenticated;
grant select, insert, update, delete on table public.notification_log to authenticated;
grant select, insert, update, delete on table public.daily_sheet_sync to authenticated;

grant all on table public.settings to service_role;
grant all on table public.admin_profiles to service_role;
grant all on table public.bookings to service_role;
grant all on table public.booking_slots to service_role;
grant all on table public.availability to service_role;
grant all on table public.audit_log to service_role;
grant all on table public.notification_log to service_role;
grant all on table public.daily_sheet_sync to service_role;

grant select on table public.active_completed_bookings to authenticated, service_role;
grant select on table public.daily_revenue_summary to authenticated, service_role;
grant select on table public.monthly_revenue_summary to authenticated, service_role;

revoke all on function public.create_booking_request(text, text, text, date, integer, integer)
  from public, anon, authenticated;
revoke all on function public.confirm_booking(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.create_manual_booking(text, text, text, date, integer, integer, uuid)
  from public, anon, authenticated;
revoke all on function public.reschedule_booking(uuid, date, integer, uuid)
  from public, anon, authenticated;
revoke all on function public.run_booking_maintenance()
  from public, anon, authenticated;

grant execute on function public.create_booking_request(text, text, text, date, integer, integer)
  to service_role;
grant execute on function public.confirm_booking(uuid, uuid)
  to service_role;
grant execute on function public.create_manual_booking(text, text, text, date, integer, integer, uuid)
  to service_role;
grant execute on function public.reschedule_booking(uuid, date, integer, uuid)
  to service_role;
grant execute on function public.run_booking_maintenance()
  to service_role;

commit;

create extension if not exists pg_cron with schema pg_catalog;

select cron.schedule(
  'the-paddle-pit-booking-maintenance',
  '*/5 * * * *',
  'select public.run_booking_maintenance();'
);
