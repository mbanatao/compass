const { json, establishSession, dbRequest } = require("../../lib/server");
const {
  CALLBACK_URL, providerConfig, verifyState, parseCookies,
  clearOAuthStateCookie, encryptRefreshToken, accountIdentityMatches
} = require("../../lib/email-oauth");

function qs(values) { return new URLSearchParams(values).toString(); }
function redirectResult(res, status, reason) {
  clearOAuthStateCookie(res);
  const url = "https://pandora-goal-compass-mbanatao.vercel.app/?" + qs({ emailConnection: status, ...(reason ? { reason } : {}) });
  res.statusCode = 302; res.setHeader("Location", url); res.end();
}
async function exchangeCode(provider, code, verifier) {
  const p = providerConfig(provider);
  const body = new URLSearchParams({
    client_id: p.clientId, client_secret: p.clientSecret, code,
    grant_type: "authorization_code", redirect_uri: CALLBACK_URL, code_verifier: verifier
  });
  const response = await fetch(p.tokenUrl, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(), redirect: "error"
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token || !data.refresh_token) throw new Error("The provider did not grant a renewable read-only email connection.");
  const granted = String(data.scope || "").split(/\s+/).filter(Boolean);
  const required = provider === "google" ?
    ["https://www.googleapis.com/auth/gmail.readonly"] : ["Mail.Read", "User.Read"];
  const has = required.every(scope => granted.some(s => s.toLowerCase() === scope.toLowerCase()));
  if (!has) throw new Error("The provider did not grant all required read-only mail permissions.");
  return { ...data, granted };
}
async function verifyIdentity(provider, accessToken) {
  if (provider === "google") {
    const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: "Bearer " + accessToken, Accept: "application/json" }, redirect: "error"
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.email_verified !== true || !data.email || !data.sub) throw new Error("Google identity verification failed.");
    return { subject: String(data.sub), email: String(data.email).toLowerCase(), displayName: String(data.name || "").slice(0, 200) };
  }
  const response = await fetch("https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName", {
    headers: { Authorization: "Bearer " + accessToken, Accept: "application/json" }, redirect: "error"
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.id) throw new Error("Microsoft identity verification failed.");
  const candidates = [data.mail, data.userPrincipalName].filter(Boolean).map(v => String(v).toLowerCase());
  return {
    subject: String(data.id),
    email: candidates[0] || "",
    candidateEmails: candidates,
    displayName: String(data.displayName || "").slice(0, 200)
  };
}
module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "GET") return json(res, 405, { error: "Method not allowed." });
  const requestUrl = new URL(req.url, "https://pandora-goal-compass-mbanatao.vercel.app");
  const errorCode = requestUrl.searchParams.get("error");
  if (errorCode) return redirectResult(res, errorCode === "access_denied" ? "cancelled" : "error", errorCode === "access_denied" ? "consent_cancelled" : "provider_rejected");
  const code = requestUrl.searchParams.get("code") || "";
  const returnedState = requestUrl.searchParams.get("state") || "";
  if (!code || code.length > 4096 || !returnedState || returnedState.length > 256) return redirectResult(res, "error", "invalid_callback");
  try {
    const cookies = parseCookies(req);
    const state = verifyState(cookies.gc_email_oauth_state, returnedState);
    if (!state || !["google", "microsoft"].includes(state.provider)) return redirectResult(res, "error", "state_expired_or_invalid");
    const session = await establishSession(req, res);
    if (!session || !session.user || session.user.id !== state.userId) return redirectResult(res, "error", "compass_session_expired");
    const token = await exchangeCode(state.provider, code, state.verifier);
    const identity = await verifyIdentity(state.provider, token.access_token);
    const identityEmails = state.provider === "microsoft" ? identity.candidateEmails : [identity.email];
    if (!accountIdentityMatches(state.provider, state.email, identityEmails)) return redirectResult(res, "error", "selected_account_mismatch");
    const storedEmail = state.provider === "google" ? identity.email : state.email;
    const now = new Date().toISOString();
    await dbRequest(session.accessToken, "goal_compass_email_connections?on_conflict=" + encodeURIComponent("user_id,provider,account_email"), {
      method: "POST", prefer: "resolution=merge-duplicates,return=minimal",
      body: {
        user_id: session.user.id,
        provider: state.provider,
        account_email: storedEmail,
        display_name: identity.displayName || null,
        provider_subject: identity.subject,
        granted_scopes: token.granted,
        status: "connected",
        token_ciphertext: encryptRefreshToken(token.refresh_token),
        access_expires_at: new Date(Date.now() + Math.min(Number(token.expires_in) || 3600, 86400) * 1000).toISOString(),
        last_error: null,
        updated_at: now
      }
    });
    return redirectResult(res, "success", "");
  } catch (e) {
    const reason = /provider did not grant|permission/i.test(String(e.message || "")) ? "permissions_not_granted" :
      /account|identity/i.test(String(e.message || "")) ? "account_identity_mismatch" : "connection_failed";
    return redirectResult(res, "error", reason);
  }
};
