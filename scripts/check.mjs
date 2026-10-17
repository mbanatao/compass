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

for (const path of ["api/health.js", "api/auth.js", "api/compass.js", "api/email.js", "api/email/callback.js", "lib/server.js", "lib/email-oauth.js"]) {
  const source = fs.readFileSync(new URL("../" + path, import.meta.url), "utf8");
  // Parse only. Function constructor catches accidental syntax regressions without executing requests.
  new Function(source.replace(/^\s*["']use strict["'];?\s*/, ""));
  console.log("PASS: " + path + " parses");
}

assert.doesNotMatch(html, /GOOGLE_OAUTH_CLIENT_SECRET|MICROSOFT_OAUTH_CLIENT_SECRET|EMAIL_OAUTH_ENCRYPTION_KEY|EMAIL_OAUTH_STATE_SECRET/, "OAuth client secrets, token-encryption keys, and state-signing keys must stay server-side");
assert.match(html, /data-page="connections"/, "Connections workspace is present");
assert.match(html, /data-email-connect/, "Email authorization controls are present");
assert.match(html, /pandora\.goal-compass/, "Compass local state namespace remains present");

console.log("Goal Compass source validation passed.");
