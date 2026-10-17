const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const serverPath = require.resolve("../lib/server");
let authMode = "success";
let lastAuthRequest = null;
let activeSession = null;
const dbCalls = [];

const fakeServer = {
  config() { return {}; },
  json(res, status, body) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.body = body;
    res.end(JSON.stringify(body));
  },
  originAllowed(req) {
    return req.headers.origin === "https://pandora-goal-compass-mbanatao.vercel.app" &&
      String(req.headers.host || "").toLowerCase() === "pandora-goal-compass-mbanatao.vercel.app";
  },
  async establishSession() { return activeSession; },
  async authFetch(route, options = {}) {
    lastAuthRequest = { route, options };
    if (authMode === "rate-limit") return { status: 429, ok: false };
    if (authMode === "failure") return { status: 500, ok: false };
    return { status: 200, ok: true };
  },
  async readResponse(response) { return response && response.data || null; },
  setSessionCookies() {},
  clearSessionCookies() {},
  async dbRequest(accessToken, route) {
    dbCalls.push({ accessToken, route });
    const table = route.split("?")[0];
    const params = new URLSearchParams(route.split("?")[1] || "");
    assert.ok(params.get("select"), "every export query must specify a projection");
    assert.notEqual(params.get("select"), "*", "export queries must use explicit column allowlists");
    assert.equal(params.get("user_id"), "eq.user-123", "every export query must be scoped to the signed-in user");
    assert.doesNotMatch(params.get("select"), /token_ciphertext|provider_subject/, "export query must omit stored provider credentials and internal identity keys");
    const rows = {
      goal_compass_goals: [{ id: "goal-1", user_id: "user-123", name: "Example goal" }],
      goal_compass_activity_events: [{ id: "event-1", user_id: "user-123", event_type: "progress", note: "Done", occurred_at: "2026-10-18T00:00:00.000Z" }],
      goal_compass_settings: [{ user_id: "user-123", planning_horizon: "today" }],
      goal_compass_goal_project_links: [{ id: "link-1", user_id: "user-123", goal_id: "goal-1", project_id: "project-1" }],
      goal_compass_email_connections: [{ id: "connection-1", user_id: "user-123", provider: "google", account_email: "person@example.com", status: "connected" }],
      goal_compass_email_signals: [{ id: "signal-1", user_id: "user-123", subject: "Review needed", review_state: "needs_review" }]
    };
    return rows[table] || [];
  }
};
require.cache[serverPath] = {
  id: serverPath,
  filename: serverPath,
  loaded: true,
  exports: fakeServer
};

const authRoute = require("../api/auth");
const exportRoute = require("../api/export");

function response() {
  const headers = new Map();
  return {
    statusCode: 200,
    getHeader(name) { return headers.get(name); },
    setHeader(name, value) { headers.set(name, value); },
    end(value) { this.bodyText = value; },
    headers,
    body: null
  };
}
function request({ method = "POST", body = {}, email = "person@example.com" } = {}) {
  return {
    method,
    body: { ...body, ...(email ? { email } : {}) },
    query: {},
    headers: {
      origin: "https://pandora-goal-compass-mbanatao.vercel.app",
      host: "pandora-goal-compass-mbanatao.vercel.app"
    }
  };
}
function jsonBody(res) { return JSON.parse(res.bodyText); }

test("password reset request uses the fixed production redirect and generic success message", async () => {
  authMode = "success";
  lastAuthRequest = null;
  const res = response();
  await authRoute(request({ body: { action: "password-recovery" } }), res);
  assert.equal(res.statusCode, 200);
  assert.match(jsonBody(res).message, /If an account exists/);
  assert.equal(lastAuthRequest.route, "recover?redirect_to=" + encodeURIComponent("https://pandora-goal-compass-mbanatao.vercel.app/?recovery=1"));
  assert.equal(lastAuthRequest.options.method, "POST");
});

test("password reset request does not disclose whether malformed or unknown addresses exist", async () => {
  lastAuthRequest = null;
  const res = response();
  await authRoute(request({ body: { action: "password-recovery" }, email: "invalid-address" }), res);
  assert.equal(res.statusCode, 200);
  assert.match(jsonBody(res).message, /If an account exists/);
  assert.equal(lastAuthRequest, null, "invalid addresses should not be sent to the provider");
});

test("password reset endpoint preserves provider rate limiting", async () => {
  authMode = "rate-limit";
  const res = response();
  await authRoute(request({ body: { action: "password-recovery" } }), res);
  assert.equal(res.statusCode, 429);
  assert.match(jsonBody(res).error, /Too many reset requests/);
  authMode = "success";
});

test("password update sends the recovery token only as bearer authorization", async () => {
  lastAuthRequest = null;
  const res = response();
  await authRoute(request({ body: { action: "set-recovered-password", recoveryAccessToken: "fixture.recovery.access-token", newPassword: "new-password-123" }, email: null }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(lastAuthRequest.route, "user");
  assert.equal(lastAuthRequest.options.method, "PUT");
  assert.equal(lastAuthRequest.options.headers.Authorization, "Bearer fixture.recovery.access-token");
  assert.equal(JSON.parse(lastAuthRequest.options.body).password, "new-password-123");
});

test("private data export rejects anonymous requests before reading any tables", async () => {
  activeSession = null;
  dbCalls.length = 0;
  const res = response();
  await exportRoute({ method: "GET", headers: { cookie: "" } }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(dbCalls.length, 0);
});

test("private data export selects only the current user's rows and excludes provider tokens", async () => {
  activeSession = { accessToken: "test-session-token", user: { id: "user-123", email: "person@example.com" } };
  dbCalls.length = 0;
  const res = response();
  await exportRoute({ method: "GET", headers: { cookie: "gc_access=fake" } }, res);
  assert.equal(res.statusCode, 200, res.bodyText);
  const data = jsonBody(res);
  assert.equal(data.account.id, "user-123");
  assert.equal(data.compass.goals.length, 1);
  assert.equal(data.compass.activity.length, 1);
  assert.equal(data.email.connections.length, 1);
  assert.equal(data.email.signals.length, 1);
  assert.equal(dbCalls.length, 6);
  assert.doesNotMatch(res.bodyText, /token_ciphertext|refresh-token-secret|service_role/i);
  assert.equal(data.email.connections[0].account_email, "person@example.com");
});
