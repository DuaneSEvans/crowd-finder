# Crowd Finder

Crowd Finder is a Vite + React map tool fronted by Supabase magic-link authentication. The current build is an authenticated map shell, ready for database-backed reads in the next phase.

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

Relevant Supabase docs:

- [Passwordless email logins](https://supabase.com/docs/guides/auth/auth-magic-link)
- [Supabase Auth overview](https://supabase.com/docs/guides/auth)

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
