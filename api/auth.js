const { config, json, originAllowed, establishSession, authFetch, readResponse, setSessionCookies, clearSessionCookies } = require("./_lib/server");
module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "GET" && req.query.action === "session") {
      const s = await establishSession(req, res);
      return json(res, 200, s ? { authenticated: true, user: { id: s.user.id, email: s.user.email } } : { authenticated: false });
    }
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed." });
    if (!originAllowed(req)) return json(res, 403, { error: "Request origin rejected." });
    const body = req.body || {};
    const action = body.action;
    if (action === "signout") {
      const s = await establishSession(req, res);
      if (s) { try { await authFetch("logout", { method: "POST", headers: { Authorization: "Bearer " + s.accessToken } }); } catch {} }
      clearSessionCookies(res);
      return json(res, 200, { ok: true });
    }
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!email || email.length > 254 || !email.includes("@") || password.length < 8 || password.length > 256) return json(res, 400, { error: "Enter a valid email and password (8–256 characters)." });
    if (action === "signup") {
      const response = await authFetch("signup", { method: "POST", body: JSON.stringify({ email, password }) });
      const data = await readResponse(response);
      if (!response.ok) return json(res, response.status >= 500 ? 502 : 400, { error: "Sign-up could not be completed. Check the details or try signing in." });
      if (data && data.access_token && data.refresh_token) {
        setSessionCookies(res, data);
        return json(res, 200, { authenticated: true, user: { id: data.user.id, email: data.user.email } });
      }
      return json(res, 200, { authenticated: false, needsConfirmation: true, message: "Check your email to confirm your account, then sign in." });
    }
    if (action === "signin") {
      const response = await authFetch("token?grant_type=password", { method: "POST", body: JSON.stringify({ email, password }) });
      const data = await readResponse(response);
      if (!response.ok || !data || !data.access_token || !data.refresh_token) return json(res, 401, { error: "Sign-in failed. Check your credentials and email confirmation." });
      setSessionCookies(res, data);
      return json(res, 200, { authenticated: true, user: { id: data.user.id, email: data.user.email } });
    }
    return json(res, 400, { error: "Unknown action." });
  } catch { return json(res, 503, { error: "Authentication service is temporarily unavailable." }); }
};
