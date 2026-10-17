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

## Recommended build order

1. Finish release gates above before connecting more private data.
2. Add **read-only calendar integration** (Google Calendar and Outlook) with clear source timestamps and schedule-conflict warnings.
3. Add a simple **daily brief** that combines confirmed calendar events, reviewed email signals, active goals, and the user's own check-in into a short prioritized plan.
4. Add **tasks** (Google Tasks, Microsoft To Do, or Todoist) with explicit goal mapping and completion confirmation.
5. Add **daily check-ins and habit tracking** without external permissions.
6. Add **personal finance** first through user-entered data and CSV import; only later consider financial-provider connections.
7. Add optional **Health Connect** summaries and personal knowledge/files integrations after consent, deletion, and retention behavior are proven.

## Integration requirements

Every source should implement the same lifecycle: explicit consent, least-privilege scope, ownership check, sync timestamp, bounded sync, deduplication, visible status/error, disconnect, deletion/revocation instructions, and a review step before source data can change a priority. Preserve an evidence trail for each recommendation: which source supplied it, when it was last checked, how it changed the score, and how the user can dismiss it.

## Release decision

Do not label the app fully production-ready until the release blockers are checked by actual tests and provider configuration is completed. Passing source-parsing and unit tests is necessary but not sufficient; live OAuth and user-isolation tests remain separate sign-off gates.
