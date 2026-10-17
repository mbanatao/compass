const crypto = require("node:crypto");

const CALLBACK_URL = process.env.EMAIL_OAUTH_CALLBACK_URL ||
  "https://pandora-goal-compass-mbanatao.vercel.app/api/email/callback";

const PROVIDERS = {
  google: {
    clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
    clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile", "https://www.googleapis.com/auth/gmail.readonly"]
  },
  microsoft: {
    clientIdEnv: "MICROSOFT_OAUTH_CLIENT_ID",
    clientSecretEnv: "MICROSOFT_OAUTH_CLIENT_SECRET",
    authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: ["offline_access", "User.Read", "Mail.Read"]
  }
};

function providerConfig(provider) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error("Unsupported email provider.");
  return { ...p, clientId: process.env[p.clientIdEnv] || "", clientSecret: process.env[p.clientSecretEnv] || "" };
}
function providerReady(provider) {
  const p = providerConfig(provider);
  return Boolean(p.clientId && p.clientSecret && process.env.EMAIL_OAUTH_STATE_SECRET && encryptionKey());
}
function encryptionKey() {
  const encoded = process.env.EMAIL_OAUTH_ENCRYPTION_KEY || "";
  if (!encoded) return null;
  const key = Buffer.from(encoded, "base64");
  return key.length === 32 ? key : null;
}
function signedState(value) {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  const signature = crypto.createHmac("sha256", process.env.EMAIL_OAUTH_STATE_SECRET || "").update(payload).digest("base64url");
  return payload + "." + signature;
}
function verifyState(cookieValue, returnedState) {
  if (!cookieValue || !process.env.EMAIL_OAUTH_STATE_SECRET) return null;
  const parts = String(cookieValue).split(".");
  if (parts.length !== 2) return null;
  const expected = crypto.createHmac("sha256", process.env.EMAIL_OAUTH_STATE_SECRET).update(parts[0]).digest();
  let actual;
  try { actual = Buffer.from(parts[1], "base64url"); } catch { return null; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const value = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (!value || value.state !== returnedState || !value.userId || !value.email || !value.provider || !value.verifier ||
        !Number.isFinite(value.expiresAt) || value.expiresAt < Date.now()) return null;
    return value;
  } catch { return null; }
}
function buildAuthorization(provider, email, userId) {
  const p = providerConfig(provider);
  if (!providerReady(provider)) {
    const vars = provider === "google" ? "GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET" :
      "MICROSOFT_OAUTH_CLIENT_ID and MICROSOFT_OAUTH_CLIENT_SECRET";
    throw Object.assign(new Error("Email OAuth is not configured. Add " + vars + " in Vercel, then redeploy."), { code: "EMAIL_OAUTH_NOT_CONFIGURED" });
  }
  const state = crypto.randomBytes(32).toString("base64url");
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const payload = { state, verifier, provider, email: email.toLowerCase(), userId, expiresAt: Date.now() + 10 * 60 * 1000 };
  const url = new URL(p.authorizeUrl);
  url.searchParams.set("client_id", p.clientId);
  url.searchParams.set("redirect_uri", CALLBACK_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", p.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("login_hint", email);
  if (provider === "google") {
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
  } else {
    url.searchParams.set("prompt", "select_account");
  }
  return { authorizationUrl: url.toString(), signedState: signedState(payload) };
}
function putCookie(res, cookie) {
  const old = res.getHeader("Set-Cookie");
  const items = Array.isArray(old) ? old : old ? [String(old)] : [];
  res.setHeader("Set-Cookie", items.concat(cookie));
}
function setOAuthStateCookie(res, signed) {
  putCookie(res, "gc_email_oauth_state=" + encodeURIComponent(signed) + "; HttpOnly; Secure; SameSite=Lax; Path=/api/email/callback; Max-Age=600");
}
function clearOAuthStateCookie(res) {
  putCookie(res, "gc_email_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/api/email/callback; Max-Age=0");
}
function encryptRefreshToken(token) {
  const key = encryptionKey();
  if (!key) throw new Error("Email token encryption is not configured.");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(token), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
}
function decryptRefreshToken(value) {
  const key = encryptionKey();
  const parts = String(value || "").split(".");
  if (!key || parts.length !== 4 || parts[0] !== "v1") throw new Error("Stored email credential cannot be decrypted.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(parts[1], "base64url"));
  decipher.setAuthTag(Buffer.from(parts[2], "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(parts[3], "base64url")), decipher.final()]).toString("utf8");
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try { out[key] = decodeURIComponent(value); } catch { out[key] = value; }
  }
  return out;
}
function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : "";
}
function accountIdentityMatches(provider, expected, actual) {
  const target = normalizeEmail(expected);
  return Boolean(target && Array.isArray(actual) && actual.map(normalizeEmail).includes(target));
}

module.exports = {
  CALLBACK_URL, PROVIDERS, providerConfig, providerReady, buildAuthorization,
  verifyState, setOAuthStateCookie, clearOAuthStateCookie, encryptRefreshToken,
  decryptRefreshToken, parseCookies, normalizeEmail, accountIdentityMatches
};
