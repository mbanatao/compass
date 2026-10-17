const test = require("node:test");
const assert = require("node:assert/strict");

const server = require("../lib/server");
const oauth = require("../lib/email-oauth");

function mockResponse() {
  const headers = new Map();
  return {
    getHeader(name) { return headers.get(name); },
    setHeader(name, value) { headers.set(name, value); },
    headers
  };
}

function withEnv(values, callback) {
  const before = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === null) delete process.env[key];
      else process.env[key] = value;
    }
    return callback();
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("cookie parser decodes values and tolerates malformed encoding", () => {
  const parsed = server.parseCookies({
    headers: { cookie: "gc_access=abc%3D123; label=Hello%20Compass; broken=%E0%A4%A" }
  });
  assert.equal(parsed.gc_access, "abc=123");
  assert.equal(parsed.label, "Hello Compass");
  assert.equal(parsed.broken, "%E0%A4%A");
});

test("mutation origin guard accepts the same host and rejects absent or foreign origins", () => {
  assert.equal(server.originAllowed({ headers: { origin: "https://compass.example", host: "compass.example" } }), true);
  assert.equal(server.originAllowed({ headers: { origin: "https://attacker.example", host: "compass.example" } }), false);
  assert.equal(server.originAllowed({ headers: { host: "compass.example" } }), false);
  assert.equal(server.originAllowed({
    headers: { origin: "https://compass.example", host: "internal.vercel", "x-forwarded-host": "compass.example" }
  }), true);
});

test("session cookies are HttpOnly, Secure, SameSite=Lax, and can be cleared", () => {
  const res = mockResponse();
  server.setSessionCookies(res, { access_token: "access", refresh_token: "refresh", expires_in: 3600 });
  const set = res.getHeader("Set-Cookie");
  assert.equal(Array.isArray(set), true);
  assert.equal(set.length, 2);
  for (const cookie of set) {
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Path=\//);
  }
  server.clearSessionCookies(res);
  const cleared = res.getHeader("Set-Cookie");
  assert.equal(cleared.length, 4);
  assert.ok(cleared.slice(2).every(cookie => /Max-Age=0/.test(cookie)));
});

test("email normalization and selected-mailbox identity matching are exact and case-insensitive", () => {
  assert.equal(oauth.normalizeEmail("  Person+Compass@Example.com "), "person+compass@example.com");
  assert.equal(oauth.normalizeEmail("not-an-email"), "");
  assert.equal(oauth.accountIdentityMatches("google", "Person@example.com", ["person@example.com"]), true);
  assert.equal(oauth.accountIdentityMatches("microsoft", "person@example.com", ["alias@example.com", "PERSON@example.com"]), true);
  assert.equal(oauth.accountIdentityMatches("google", "person@example.com", ["different@example.com"]), false);
  assert.equal(oauth.accountIdentityMatches("google", "person@example.com", null), false);
});

test("provider requests are read-only and exclude send or mailbox-write scopes", () => {
  const google = oauth.providerConfig("google").scopes;
  const microsoft = oauth.providerConfig("microsoft").scopes;
  assert.ok(google.includes("https://www.googleapis.com/auth/gmail.readonly"));
  assert.equal(google.some(scope => /gmail\.(?:modify|send|insert|compose|settings)/i.test(scope)), false);
  assert.ok(microsoft.includes("Mail.Read"));
  assert.ok(microsoft.includes("User.Read"));
  assert.ok(microsoft.includes("offline_access"));
  assert.equal(microsoft.some(scope => /Mail\.ReadWrite|Mail\.Send/i.test(scope)), false);
});

test("refresh tokens are encrypted with authenticated AES-GCM and detect tampering", () => {
  const key = Buffer.alloc(32, 0x42).toString("base64");
  withEnv({ EMAIL_OAUTH_ENCRYPTION_KEY: key }, () => {
    const token = "private-refresh-token-fixture";
    const encrypted = oauth.encryptRefreshToken(token);
    assert.notEqual(encrypted, token);
    assert.equal(oauth.decryptRefreshToken(encrypted), token);
    const parts = encrypted.split(".");
    parts[3] = (parts[3][0] === "A" ? "B" : "A") + parts[3].slice(1);
    assert.throws(() => oauth.decryptRefreshToken(parts.join(".")));
  });
});

test("OAuth authorization binds signed state to the user, mailbox, provider, and PKCE challenge", () => {
  const key = Buffer.alloc(32, 0x7a).toString("base64");
  withEnv({
    GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
    EMAIL_OAUTH_ENCRYPTION_KEY: key,
    EMAIL_OAUTH_STATE_SECRET: "unit-test-state-signing-secret"
  }, () => {
    const result = oauth.buildAuthorization("google", "Person@Example.com", "user-fixture-id");
    const url = new URL(result.authorizationUrl);
    assert.equal(url.hostname, "accounts.google.com");
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.ok(url.searchParams.get("code_challenge"));
    assert.ok(url.searchParams.get("scope").includes("gmail.readonly"));

    const state = url.searchParams.get("state");
    const claims = oauth.verifyState(result.signedState, state);
    assert.equal(claims.userId, "user-fixture-id");
    assert.equal(claims.provider, "google");
    assert.equal(claims.email, "person@example.com");
    assert.equal(oauth.verifyState(result.signedState, "different-state"), null);
    assert.equal(oauth.verifyState(result.signedState.replace(/\.[^.]+$/, ".invalid"), state), null);
  });
});

test("OAuth authorization fails closed when provider credentials are missing", () => {
  withEnv({
    GOOGLE_OAUTH_CLIENT_ID: null,
    GOOGLE_OAUTH_CLIENT_SECRET: null,
    EMAIL_OAUTH_ENCRYPTION_KEY: null,
    EMAIL_OAUTH_STATE_SECRET: null
  }, () => {
    assert.throws(
      () => oauth.buildAuthorization("google", "person@example.com", "user-fixture-id"),
      error => error && error.code === "EMAIL_OAUTH_NOT_CONFIGURED"
    );
  });
});
