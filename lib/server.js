const ACCESS = "gc_access";
const REFRESH = "gc_refresh";
function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Supabase server configuration is incomplete.");
  return { url: url.replace(/\/+$/, ""), key };
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("="); if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}
function putCookies(res, items) {
  const old = res.getHeader("Set-Cookie");
  const list = Array.isArray(old) ? old : old ? [String(old)] : [];
  res.setHeader("Set-Cookie", list.concat(items));
}
function setSessionCookies(res, s) {
  const age = Math.max(60, Math.min(Number(s.expires_in) || 3600, 86400));
  putCookies(res, [
    ACCESS + "=" + encodeURIComponent(s.access_token) + "; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=" + age,
    REFRESH + "=" + encodeURIComponent(s.refresh_token) + "; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000"
  ]);
}
function clearSessionCookies(res) {
  putCookies(res, [ACCESS + "=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0", REFRESH + "=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0"]);
}
function json(res, status, body) {
  res.statusCode = status; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store, max-age=0"); res.end(JSON.stringify(body));
}
function originAllowed(req) {
  const origin = req.headers.origin; if (!origin) return false;
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim().toLowerCase();
  try { return new URL(origin).host.toLowerCase() === host; } catch { return false; }
}
async function authFetch(path, options = {}) {
  const c = config(), headers = new Headers(options.headers || {});
  headers.set("apikey", c.key); headers.set("Accept", "application/json");
  if (options.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return fetch(c.url + "/auth/v1/" + path, { ...options, headers });
}
async function readResponse(response) { if (response.status === 204) return null; try { return await response.json(); } catch { return null; } }
async function establishSession(req, res) {
  const cookies = parseCookies(req);
  if (cookies[ACCESS]) {
    try {
      const response = await authFetch("user", { headers: { Authorization: "Bearer " + cookies[ACCESS] } });
      if (response.ok) return { accessToken: cookies[ACCESS], refreshToken: cookies[REFRESH] || null, user: await readResponse(response) };
    } catch {}
  }
  if (cookies[REFRESH]) {
    try {
      const response = await authFetch("token?grant_type=refresh_token", { method: "POST", body: JSON.stringify({ refresh_token: cookies[REFRESH] }) });
      const s = await readResponse(response);
      if (response.ok && s && s.access_token && s.refresh_token) { setSessionCookies(res, s); return { accessToken: s.access_token, refreshToken: s.refresh_token, user: s.user }; }
    } catch {}
  }
  if (cookies[ACCESS] || cookies[REFRESH]) clearSessionCookies(res);
  return null;
}
async function dbRequest(accessToken, path, options = {}) {
  const c = config(), headers = new Headers(options.headers || {});
  headers.set("apikey", c.key); headers.set("Authorization", "Bearer " + accessToken); headers.set("Accept", "application/json");
  if (options.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (options.prefer) headers.set("Prefer", options.prefer);
  const response = await fetch(c.url + "/rest/v1/" + path, { method: options.method || "GET", headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const data = await readResponse(response);
  if (!response.ok) { const err = new Error("Supabase data request failed."); err.status = response.status; err.code = data && typeof data.code === "string" ? data.code : "DATA_REQUEST_FAILED"; throw err; }
  return data;
}
module.exports = { config, parseCookies, setSessionCookies, clearSessionCookies, json, originAllowed, authFetch, readResponse, establishSession, dbRequest };
