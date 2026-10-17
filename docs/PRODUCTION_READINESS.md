# Goal Compass production readiness

Status assessed against the deployed application and repository on 2026-10-18.

**Current status: deployed, but not yet release-complete for public production use.** A reachable production URL and a successful liveness response are not proof that all account, privacy, integration, recovery, or monitoring workflows are production-ready.

## Verified foundations

- Static frontend and same-origin serverless API.
- Supabase Auth sessions held in Secure, HttpOnly cookies.
- Personal Compass tables have Row Level Security enabled; initial policy review shows user-scoped access policies.
- Goal scoring is deterministic and its main inputs are user-editable.
- Email authorization uses OAuth state, PKCE S256, mailbox identity matching, read-only mail scopes, and AES-GCM-encrypted refresh tokens.
- scripts/check.mjs parses the browser and server JavaScript and guards against bundling server-only secrets.
- Production deployment and basic HTTP smoke checks were previously verified.

## Release blockers before calling this production-ready

- [ ] **OAuth setup and live verification:** configure Google and Microsoft OAuth client credentials in the required Vercel environments; register the production callback URL; validate connect, consent cancellation, account mismatch, first sync, repeated/idempotent sync, token refresh, expired consent, disconnect, and provider-side revocation against real test accounts.
- [ ] **Account recovery and lifecycle:** add and test password-reset/recovery UX, account deletion, and a portable export of goals, activity, settings, and reviewed signals. A user must be able to leave without filing a support request.
- [ ] **Isolation tests:** use two real test accounts to prove that goals, activity, settings, links, mailbox connections, and signals cannot be read or changed across users, including via direct API calls and manipulated IDs.
- [ ] **Automated behavioral tests:** go beyond syntax checks. Cover cookie/origin rules, OAuth state and PKCE, token encryption, provider scopes, data validation, unauthorized requests, duplicate sync, and failure recovery. Add browser-level smoke tests for the critical signup/sign-in/save/reload/sign-out flows.
- [ ] **Release controls:** link the canonical repository to the intended Vercel project, verify preview deployments and production promotion from commits, require CI on pull requests, and document rollback.
- [ ] **Operational observability:** confirm authorized access to production runtime logs and errors, add actionable alerts, and distinguish process liveness from dependency readiness without leaking secrets.
- [ ] **Security and privacy review:** confirm retention rules, revocation semantics, rate limiting/abuse controls, HTTPS/security headers, consent copy, and that stale/unavailable source data never silently appears as current.
- [ ] **Human verification:** test mobile viewport/keyboard accessibility, screen-reader labels, empty/loading/error states, offline/local-demo messaging, and data import/restore on real devices.

## Core decision-loop implementation

The current feature branch implements the first usable version of the daily decision loop: a Today page with up to three deterministically ranked actions, explanations derived from visible goal inputs and linked signals, explicit focus/start/defer actions, a self-reported check-in, and a seven-day review of logged activity. Check-in energy and available time are stored as context only; they do not yet alter scores. The calendar remains disconnected, so true time availability and schedule conflicts are not inferred. These changes are in the draft PR and have not been merged or deployed.

## Recommended build order

1. Validate the daily page, event persistence, mobile behavior, and weekly calculations on the feature branch; run CI and correct any test failures.
2. Finish release gates above before connecting more private data, especially password recovery/export/deletion, two-account isolation tests, and real OAuth lifecycle tests.
3. Add **read-only calendar integration** (Google Calendar and Outlook) with clear source timestamps and schedule-conflict warnings. Use it to inform, not silently decide, a daily time budget.
4. Add **tasks** (Google Tasks, Microsoft To Do, or Todoist) with explicit goal mapping and completion confirmation.
5. Extend **daily check-ins and habit tracking** with optional reminders and user-controlled retention.
6. Add **personal finance** first through user-entered data and CSV import; only later consider financial-provider connections.
7. Add optional **Health Connect** summaries and personal knowledge/files integrations after consent, deletion, and retention behavior are proven.

## Integration requirements

Every source should implement the same lifecycle: explicit consent, least-privilege scope, ownership check, sync timestamp, bounded sync, deduplication, visible status/error, disconnect, deletion/revocation instructions, and a review step before source data can change a priority. Preserve an evidence trail for each recommendation: which source supplied it, when it was last checked, how it changed the score, and how the user can dismiss it.

## Release decision

Do not label the app fully production-ready until the release blockers are checked by actual tests and provider configuration is completed. Passing source-parsing and unit tests is necessary but not sufficient; live OAuth and user-isolation tests remain separate sign-off gates.
