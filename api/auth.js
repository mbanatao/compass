const { config, json, originAllowed, establishSession, authFetch, readResponse, setSessionCookies, clearSessionCookies } = require("../lib/server");
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
    if (action === "password-recovery") {
      const email = String(body.email || "").trim().toLowerCase();
      const generic = "If an account exists for that address, a password-reset email will be sent.";
      if (!email || email.length > 254 || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) {
        return json(res, 200, { ok: true, message: generic });
      }
      const redirectTo = "https://pandora-goal-compass-mbanatao.vercel.app/?recovery=1";
      const response = await authFetch("recover?redirect_to=" + encodeURIComponent(redirectTo), {
        method: "POST",
        body: JSON.stringify({ email })
      });
      if (response.status === 429) return json(res, 429, { error: "Too many reset requests. Wait a while and try again." });
      if (!response.ok) return json(res, 502, { error: "Password recovery is temporarily unavailable. Try again later." });
      return json(res, 200, { ok: true, message: generic });
    }
    if (action === "set-recovered-password") {
      const recoveryAccessToken = String(body.recoveryAccessToken || "");
      const newPassword = String(body.newPassword || "");
      if (recoveryAccessToken.length < 20 || recoveryAccessToken.length > 4096 || !recoveryAccessToken.includes(".") ||
          newPassword.length < 8 || newPassword.length > 256) {
        return json(res, 400, { error: "The reset link or new password is invalid." });
      }
      const response = await authFetch("user", {
        method: "PUT",
        headers: { Authorization: "Bearer " + recoveryAccessToken },
        body: JSON.stringify({ password: newPassword })
      });
      if (!response.ok) return json(res, response.status === 429 ? 429 : 400, {
        error: response.status === 429 ? "Too many attempts. Wait a while and try again." : "This reset link is invalid or expired. Request a new password-reset email."
      });
      return json(res, 200, { ok: true });
    }
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
