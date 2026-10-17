import fs from "node:fs";
import assert from "node:assert/strict";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
assert.match(html, /<title>Goal Compass — Pandora<\/title>/, "index.html has the expected product title");
assert.doesNotMatch(html, /SUPABASE_SERVICE_ROLE_KEY|service_role/i, "A server-only Supabase service-role secret must never be bundled into the page");
assert.doesNotMatch(html, /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/, "No JWT should be hard-coded in the page");

const inlineScripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
assert.ok(inlineScripts.length > 0, "index.html includes the application script");
for (const [index, match] of inlineScripts.entries()) {
  // Parse only. Do not execute application code in CI.
  new Function(match[1]);
  console.log("PASS: index.html inline script " + (index + 1) + " parses");
}

for (const path of ["api/health.js", "api/auth.js", "api/compass.js", "api/email.js", "api/email/callback.js", "api/export.js", "lib/server.js", "lib/email-oauth.js"]) {
  const source = fs.readFileSync(new URL("../" + path, import.meta.url), "utf8");
  // Parse only. Function constructor catches accidental syntax regressions without executing requests.
  new Function(source.replace(/^\s*["']use strict["'];?\s*/, ""));
  console.log("PASS: " + path + " parses");
}

assert.doesNotMatch(html, /GOOGLE_OAUTH_CLIENT_SECRET|MICROSOFT_OAUTH_CLIENT_SECRET|EMAIL_OAUTH_ENCRYPTION_KEY|EMAIL_OAUTH_STATE_SECRET/, "OAuth client secrets, token-encryption keys, and state-signing keys must stay server-side");
assert.match(html, /data-page="today"/, "Daily command center is present");
assert.match(html, /data-page="review"/, "Weekly review is present");
assert.match(html, /id="forgotPassword"/, "Password recovery entry point is present");
assert.match(html, /id="recoveryUpdateForm"/, "Password recovery completion form is present");
assert.match(html, /function consumePasswordRecoveryReturn\(/, "Password recovery callback handler is present");
assert.match(html, /id="exportDataButton"/, "Data export control is present");
assert.match(html, /function exportPersonalData\(/, "Data export handler is present");
const authApi = fs.readFileSync(new URL("../api/auth.js", import.meta.url), "utf8");
assert.match(authApi, /password-recovery/, "Password recovery endpoint is present");
assert.match(authApi, /set-recovered-password/, "Password update endpoint is present");
assert.match(authApi, /\?recovery=1/, "Password recovery redirect is fixed to the production origin");
const exportApi = fs.readFileSync(new URL("../api/export.js", import.meta.url), "utf8");
assert.match(exportApi, /goal_compass_email_signals/, "Data export includes saved email signals");
assert.doesNotMatch(exportApi, /token_ciphertext/, "Data export must not select encrypted provider refresh tokens");

assert.match(html, /id="dailyPlan"/, "Daily recommendations region is present");
assert.match(html, /id="dailyCheckinForm"/, "Daily check-in form is present");
assert.match(html, /function renderToday\(/, "Daily plan render function is present");
assert.match(html, /function renderWeeklyReview\(/, "Weekly review render function is present");
assert.match(html, /daily-check-in:/, "Daily check-in records are date-bound");
assert.match(html, /compass-not-now:/, "Daily deferrals are date-bound");
assert.match(html, /data-page="connections"/, "Connections workspace is present");
assert.match(html, /data-email-connect/, "Email authorization controls are present");
assert.match(html, /pandora\.goal-compass/, "Compass local state namespace remains present");

console.log("Goal Compass source validation passed.");
