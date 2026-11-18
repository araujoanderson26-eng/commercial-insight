import { createRemoteJWKSet, jwtVerify } from "jose";
import { Buffer } from "node:buffer";
import { type ModelConfig } from "../shared/domain";
import { origin } from "./auth";
import { audit, digest, fail, now, stmt, token, type DbUser, type Env } from "./core";
const resource = "https://analysis.windows.net/powerbi/api/";
const scope = "openid offline_access " + resource + "Dataset.Read.All";
const redirect = (e: Env) => origin(e) + "/api/microsoft/callback";
type Tokens = {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
};
async function exchange(e: Env, m: ModelConfig, params: Record<string, string>): Promise<Tokens> {
  if (!e.MS_CLIENT_SECRET) fail(503, "Cadastre o segredo do aplicativo Microsoft no Worker.");
  const res = await fetch("https://login.microsoftonline.com/" + m.tenant + "/oauth2/v2.0/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: m.application,
      client_secret: e.MS_CLIENT_SECRET,
      ...params,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok)
    fail(
      res.status === 429 ? 429 : 409,
      "A Microsoft recusou a autorização. Verifique a credencial, o consentimento e o vínculo no Perfil.",
    );
  const v = await res.json<Tokens>();
  if (!v.access_token) fail(502, "Resposta Microsoft incompleta.");
  return v;
}
async function key(e: Env) {
  const k = Buffer.from(e.TOKEN_ENCRYPTION_KEY || "", "base64");
  if (k.length !== 32) fail(503, "Configure a chave de criptografia de 32 bytes.");
  return crypto.subtle.importKey("raw", k, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function seal(e: Env, id: string, plain: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(id) },
    await key(e),
    new TextEncoder().encode(plain),
  );
  return Buffer.from(iv).toString("base64") + "." + Buffer.from(enc).toString("base64");
}
async function open(e: Env, id: string, value: string) {
  const [iv, cipher] = value.split(".");
  try {
    return new TextDecoder().decode(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: Buffer.from(iv, "base64"),
          additionalData: new TextEncoder().encode(id),
        },
        await key(e),
        Buffer.from(cipher, "base64"),
      ),
    );
  } catch {
    fail(409, "Vincule novamente a conta Microsoft no Perfil.");
  }
}
export async function start(e: Env, m: ModelConfig, rev: number, u: DbUser, session: string) {
  if (m.mode !== "delegated" || !u.entra_oid)
    fail(
      409,
      "O administrador deve cadastrar o ID de objeto Microsoft deste usuário e ativar o modo delegado.",
    );
  await key(e);
  const state = token(),
    nonce = token(),
    verifier = token();
  const challenge = Buffer.from(await digest(verifier), "hex").toString("base64url");
  await stmt(
    e,
    "INSERT INTO oauth_state VALUES(?,?,?,?,?,?,?)",
    await digest(state),
    u.id,
    session,
    verifier,
    nonce,
    rev,
    now() + 600,
  ).run();
  const qs = new URLSearchParams({
    client_id: m.application,
    redirect_uri: redirect(e),
    response_type: "code",
    response_mode: "query",
    scope,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  return { url: "https://login.microsoftonline.com/" + m.tenant + "/oauth2/v2.0/authorize?" + qs };
}
export async function finish(
  e: Env,
  m: ModelConfig,
  rev: number,
  u: DbUser,
  session: string,
  url: URL,
) {
  const state = url.searchParams.get("state") || "",
    code = url.searchParams.get("code");
  const row = await stmt(
    e,
    "DELETE FROM oauth_state WHERE state=? AND owner=? AND session_hash=? AND revision=? AND expires>? RETURNING verifier,nonce",
    await digest(state),
    u.id,
    session,
    rev,
    now(),
  ).first<{ verifier: string; nonce: string }>();
  if (!row || !code || m.mode !== "delegated") fail(400, "Autorização expirada ou cancelada.");
  const t = await exchange(e, m, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirect(e),
    code_verifier: row.verifier,
    scope,
  });
  const jwks = createRemoteJWKSet(
    new URL("https://login.microsoftonline.com/" + m.tenant + "/discovery/v2.0/keys"),
  );
  if (!t.id_token || !t.refresh_token)
    fail(403, "O vínculo exige consentimento para acesso delegado.");
  const { payload } = await jwtVerify(t.id_token, jwks, {
    issuer: "https://login.microsoftonline.com/" + m.tenant + "/v2.0",
    audience: m.application,
    algorithms: ["RS256"],
  }).catch(() => fail(403, "Identidade Microsoft inválida."));
  if (payload.oid !== u.entra_oid || payload.tid !== m.tenant || payload.nonce !== row.nonce)
    fail(403, "Esta identidade não corresponde ao cadastro.");
  const bundle = {
    access: t.access_token,
    refresh: t.refresh_token,
    expires: now() + t.expires_in,
  };
  await e.DB.batch([
    stmt(
      e,
      "INSERT OR REPLACE INTO microsoft_tokens VALUES(?,?,?)",
      u.id,
      rev,
      await seal(e, u.id, JSON.stringify(bundle)),
    ),
    audit(e, u.id, "microsoft_vinculado"),
  ]);
}
export async function access(e: Env, m: ModelConfig, rev: number, u: DbUser) {
  if (m.mode === "application") {
    return (
      await exchange(e, m, { grant_type: "client_credentials", scope: resource + ".default" })
    ).access_token;
  }
  const row = await stmt(
    e,
    "SELECT encrypted FROM microsoft_tokens WHERE owner=? AND revision=?",
    u.id,
    rev,
  ).first<{ encrypted: string }>();
  if (!row || !u.entra_oid) fail(409, "Vincule sua conta Microsoft em Meu perfil.");
  const stored = JSON.parse(await open(e, u.id, row.encrypted)) as {
    access: string;
    refresh: string;
    expires: number;
  };
  if (stored.expires > now() + 90) return stored.access;
  const t = await exchange(e, m, {
    grant_type: "refresh_token",
    refresh_token: stored.refresh,
    scope,
  });
  const next = {
    access: t.access_token,
    refresh: t.refresh_token || stored.refresh,
    expires: now() + t.expires_in,
  };
  await stmt(
    e,
    "UPDATE microsoft_tokens SET encrypted=? WHERE owner=? AND revision=? AND encrypted=?",
    await seal(e, u.id, JSON.stringify(next)),
    u.id,
    rev,
    row.encrypted,
  ).run();
  return t.access_token;
}
