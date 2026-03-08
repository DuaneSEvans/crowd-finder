# Crowd Finder

Crowd Finder is a Vite + React map tool fronted by Supabase magic-link authentication. The current build is an authenticated map shell, and the repo now includes a Supabase SQL migration workflow for the app schema.

## Frontend env

Create a local `.env` file from `.env.example`:

```bash
cp .env.example .env
```

Required values:

- `VITE_GOOGLE_MAPS_API_KEY`: browser-safe Google Maps JavaScript API key.
- `VITE_SUPABASE_URL`: your Supabase project URL.
- `VITE_SUPABASE_ANON_KEY`: your Supabase publishable/anon key.

## Supabase dashboard setup

As of March 8, 2026, the app expects the following Supabase Auth configuration:

1. Create a Supabase project.
2. In `Authentication`, keep the `Email` provider enabled.
3. Use magic links/passwordless email login.
4. In URL configuration:
   - set `Site URL` to `http://localhost:5173` for local development
   - add redirect URLs for:
     - `http://localhost:5173`
     - `http://localhost:5173/login`
     - `http://localhost:5173/map`
     - your production origin
     - your production `/login` path
     - your production `/map` path
5. Create or invite the one allowed user from the Supabase dashboard instead of exposing a self-serve signup flow.

The app sends magic links with `shouldCreateUser: false`, so an unknown email address cannot create a new account through the login form.

## Schema workflow

This repo uses the Supabase CLI and SQL migrations as the schema source of truth.

Key paths:

- `supabase/config.toml`
- `supabase/migrations/`
- `src/lib/database.types.ts`

Useful commands:

```bash
bun run db:start
bun run db:up
bun run db:types
bun run db:import:local
bun run db:migrate:production
bun run db:stop
```

Normal local workflow:

1. Create a new SQL migration file in `supabase/migrations/`.
2. Run `bun run db:up`.
3. Run `bun run db:types`.

Notes:

- For normal local schema changes, create a new migration file, run `db:up`, then run `db:types`. This preserves local data.
- `db:types` generates types from the local Supabase database into `src/lib/database.types.ts`.
- `db:import:local` reads all CSV files in `supabase/rawData/`, aggregates contacts/events/contact-event counts, and upserts them into the local database.
- `db:import:local -- --dry-run` parses and summarizes the import without writing to the database.
- `db:import:local -- /absolute/or/relative/path` lets you target a single CSV file or a different directory.
- The importer defaults to `postgresql://postgres:postgres@127.0.0.1:54322/postgres` and will use `DATABASE_URL` if you want to override it.
- `bun run db:migrate:production` links the hosted Supabase project and runs `supabase db push --dry-run`.
- `bun run db:migrate:production --write` performs the real production push.
- Remote schema admin is still available through the Supabase CLI directly when needed, for example:

```bash
bunx supabase link --project-ref hdeyrmgwudbmnanlsmll
bunx supabase db push
```

- Remote schema deployment should be an explicit release step, not part of the Cloudflare Pages build.

## Local development

Install dependencies and start the app:

```bash
bun install
bun run dev
```

Then:

1. Open `http://localhost:5173`.
2. Enter the invited email address.
3. Click the magic link in that same browser.
4. You should land in the authenticated map workspace.

## Scripts

- `bun run dev`
- `bun run build`
- `bun run lint`
- `bun run db:import:local`
- `bun run db:migrate:production`
- `bun run db:start`
- `bun run db:stop`
- `bun run db:up`
- `bun run db:types`
