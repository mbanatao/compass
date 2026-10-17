# Pandora Goal Compass

A responsive Goal Compass web app for navigating priorities, progress, and next actions. The frontend is a static HTML application; the private-data endpoints run as Vercel serverless functions.

## Live app

- Production: https://pandora-goal-compass-mbanatao.vercel.app
- Repository: https://github.com/mbanatao/compass
- Production readiness checklist: docs/PRODUCTION_READINESS.md

## Current capabilities

- Compass directions, current focus, and deterministic priority scoring.
- Daily Command Center with up to three evidence-explained next actions, explicit focus/start/defer controls, and date-bound deferrals.
- Self-reported daily check-in for energy, available focus time, attention, wins, and blockers; the check-in itself is not a completion claim, and an explicitly reported blocker is recorded separately.
- Self-service password-reset request and password-update flow; the production redirect must be allowlisted in Supabase Auth and the reset email flow still requires live verification.
- On-demand JSON export of Compass goals, activity, preferences, visible Pandora context, and email signal metadata; provider credentials are excluded.
- Seven-day review of logged progress, blockers, check-ins, and explicitly recorded time; missing entries are not interpreted as proof that nothing happened.
- Today, This week, and North Star planning horizons.
- User-owned goals with direction, success definition, next action, progress, importance, urgency, impact, momentum, evidence confidence, status, and optional deadline.
- User-directed priority override for the local day.
- Manual activity journal with provenance; raw activity is not promoted to permanent Memory automatically.
- Unlimited user-owned goals grouped across four compass bearings, with the dial showing the highest-priority goal within each bearing.
- Explicit links from personal goals to visible Pandora projects.
- Read-only, best-effort source context from permitted Pandora project/task/decision records, promoted lessons, processed integration-event metadata, and project experience projections.
- Source freshness/status and record counts displayed separately from user-entered activity.
- Private Supabase Auth sessions held in Secure, HttpOnly cookies; database requests use the signed-in user's access token so Supabase Row Level Security continues to apply.
- Per-user Supabase persistence for goals, settings, activity, and goal-project links.
- Responsive mobile layout and dark/light themes.

## Data flow

```text
Browser UI
  -> same-origin /api/auth (sign-up, sign-in, session, sign-out)
  -> HttpOnly session cookie
  -> same-origin /api/compass
  -> Supabase Auth + PostgREST using the signed-in user's JWT
  -> Row Level Security
  -> per-user Goal Compass tables + permitted Pandora source records
  -> deterministic scoring + displayed evidence
```

The Supabase project URL and publishable key are configured as Vercel environment variables and used server-side. No service-role key is needed or embedded in the browser. Do not move Supabase secrets into `index.html`.

## Supabase schema

Migration `goal_compass_personal_data_and_rls` creates:

- `goal_compass_goals`
- `goal_compass_activity_events`
- `goal_compass_settings`
- `goal_compass_goal_project_links`
- `goal_compass_email_connections` (RLS-protected; encrypted refresh tokens)
- `goal_compass_email_signals` (minimal metadata and user-reviewed candidate signals)

Each table uses Row Level Security. Personal goals remain separate from Pandora's project/task records; linking a project is an explicit user action. The application only receives source rows that the signed-in user's current Supabase permissions allow.

## Configure Vercel

Project name: `pandora-goal-compass-mbanatao`

Required environment variables (server-side only):
- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY` (or legacy `SUPABASE_ANON_KEY`)

Runtime functions: `api/auth.js`, `api/compass.js`, `api/health.js`.

The project was deployed from GitHub source directly because the connected Vercel Git provider reported that it did not have access to this repo at project-link time. Consequently, future pushes may not auto-deploy until Vercel's GitHub integration has access to `mbanatao/compass`.

## Local run and source validation

Open `index.html` in a modern browser for local/demo mode. Authenticated cloud mode requires the Vercel API routes and the server environment variables.

Run the dependency-free source parse checks with:

```sh
node scripts/check.mjs
```

GitHub Actions runs this validation on pushes to `main` and on pull requests.

## Scoring and evidence limits

Active goals are scored deterministically from five editable 1–5 factors: importance, urgency, impact, momentum, and evidence confidence. The weights depend on the chosen horizon. A near-term deadline raises effective urgency. Paused and completed goals are excluded. A current-day user override wins in Today mode, with its manual origin labeled explicitly.

When a goal is explicitly linked to visible Pandora projects, explicit blocked/failed/review task states and the project experience `needs_you` flag can raise urgency. Completed tasks from the last seven days can raise the momentum factor. Recent user-logged `Progress` events add a small momentum signal, and user-logged `Blocker` events add a small urgency signal; other raw event volume does not change the score. These small, inspectable heuristics do not establish what the user has actually done in the physical world.

## Email connections

The Connections workspace is available at `/api/email` and the OAuth callback is `/api/email/callback`. The OAuth flow uses state bound to the current signed-in Compass user, PKCE S256, a short-lived HttpOnly/Secure/SameSite=Lax state cookie, exact mailbox identity matching, and read-only provider scopes.

Before enabling Connect, set these Vercel environment variables for Production, Preview, and Development, then redeploy:

- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `MICROSOFT_OAUTH_CLIENT_ID`
- `MICROSOFT_OAUTH_CLIENT_SECRET`

The token-encryption key (`EMAIL_OAUTH_ENCRYPTION_KEY`) and OAuth state-signing secret (`EMAIL_OAUTH_STATE_SECRET`) have already been configured as encrypted Vercel environment variables. The canonical callback URI to register in both provider apps is:

`https://pandora-goal-compass-mbanatao.vercel.app/api/email/callback`

Google needs Gmail read-only access (`gmail.readonly`) plus basic verified identity; Microsoft needs `Mail.Read`, `User.Read`, and `offline_access`. Each mailbox is connected separately after the provider consent screen verifies that the selected email matches the requested address. Google may require OAuth consent-screen configuration or app verification before external Gmail accounts can grant the requested scope.

Sync is manual, reads at most 25 inbox messages from the last 14 days per account, and uses subject plus a short preview transiently to classify possible replies, deadlines, commitments, and follow-ups. Compass persists only message subject, sender metadata, timestamp, classification, confidence, explanation, user review state, and a provider message link—not the full body or preview. Classifications are heuristic candidates, not verified obligations; the user must review them. Only confirmed signals explicitly linked to a personal goal can affect its urgency, with a small bounded adjustment for overdue/near-term deadlines and reply requests. Dismissed, unreviewed, unlinked, or completed signals do not influence scoring. Compass never sends or deletes email.

Refresh tokens are encrypted with AES-256-GCM before being stored in a user-owned row protected by Supabase RLS. The encryption key is server-side only. Disconnect removes that connection and its saved signals from Compass; use each provider's security settings to revoke the app's consent completely if desired.

## Daily decision loop

The Today page ranks active goals from the existing deterministic scoring model, surfaces target-date and available confirmed/linked source signals where present, and explains the reasons shown on each recommendation. The user remains in control: Focus this records a daily priority choice, Start action records an action-started event, and Not now records a date-bound deferral until the next local day. The weekly Review page summarizes manually recorded activity over the prior seven days; it does not claim to measure unobserved behavior.

The calendar is not connected yet, so the app must not imply it can see true availability or detect schedule conflicts. Daily check-ins are self-reports. Energy and available-time selections are recorded as context; they do not currently change the deterministic scoring weights.

## Not connected yet

- Google/Outlook email access is implemented but remains inactive until OAuth client credentials are configured in Vercel and each mailbox is authorized.
- Calendar, health, finance, and other personal-life provider integrations.
- Pandora Memory API integration for durable learned lessons or cross-context context packs.
- Automatic phone sensor/gyroscope orientation.
- Background activity tracking or automatic task-completion detection.
- Automatic GitHub-to-Vercel redeployment until repository access is granted.

The four default goal names and their factor values are user-editable starter inputs, not claims about the user's life. Recommendations should not be treated as authoritative if source permissions fail, linked data is stale, or a goal has insufficient evidence.