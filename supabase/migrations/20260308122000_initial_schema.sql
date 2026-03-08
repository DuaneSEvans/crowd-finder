create extension if not exists pgcrypto with schema extensions;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.normalize_event_name(input text)
returns text
language sql
immutable
strict
as $$
  select lower(trim(regexp_replace(input, '\s+', ' ', 'g')));
$$;

create table public.contacts (
  id uuid primary key default extensions.gen_random_uuid(),
  email text not null unique,
  first_name text,
  last_name text,
  phone text,
  street text,
  postcode text,
  city text,
  country text,
  country_code text,
  lat double precision,
  lng double precision,
  last_imported_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.events (
  id uuid primary key default extensions.gen_random_uuid(),
  name text not null,
  event_date timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index events_name_event_date_key
  on public.events (public.normalize_event_name(name), event_date);

create table public.contact_events (
  contact_id uuid not null references public.contacts(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  ticket_count integer not null default 1,
  latest_booking_date timestamptz,
  created_at timestamptz not null default now(),
  primary key (contact_id, event_id)
);

create trigger set_contacts_updated_at
before update on public.contacts
for each row
execute function public.set_updated_at();

create trigger set_events_updated_at
before update on public.events
for each row
execute function public.set_updated_at();

alter table public.contacts enable row level security;
alter table public.events enable row level security;
alter table public.contact_events enable row level security;

grant usage on schema public to authenticated;
grant select on public.contacts to authenticated;
grant select on public.events to authenticated;
grant select on public.contact_events to authenticated;

create policy "Authenticated users can read contacts"
on public.contacts
for select
to authenticated
using (true);

create policy "Authenticated users can read events"
on public.events
for select
to authenticated
using (true);

create policy "Authenticated users can read contact_events"
on public.contact_events
for select
to authenticated
using (true);
