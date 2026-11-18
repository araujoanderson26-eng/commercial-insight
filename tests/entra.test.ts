import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { access, finish, start } from "../worker/entra";
import { type DbUser } from "../worker/core";
import { makeStore, model } from "./fixtures";
test("OAuth delegado usa PKCE, sessão, nonce, identidade cadastrada e token cifrado por usuário", async (t) => {
  const { env, sql } = makeStore();
  t.after(() => sql.close());
  env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  const m = { ...model, mode: "delegated" as const };
  const u = { id: randomUUID(), entra_oid: randomUUID() } as DbUser;
  sql
    .prepare("INSERT INTO users(id,email,name,password,role,created) VALUES(?,?,?,?,?,unixepoch())")
    .run(u.id, "test@example.test", "Teste", "hash sintético", "gerente");
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "local", alg: "RS256", use: "sig" };
  let nonce = "",
    oid = u.entra_oid,
    verifier = "",
    refreshes = 0;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/discovery/v2.0/keys")) return Response.json({ keys: [jwk] });
    const params = init?.body as URLSearchParams;
    if (params.get("grant_type") === "refresh_token") {
      refreshes++;
      return Response.json({
        access_token: "renovado",
        refresh_token: "rotacionado",
        expires_in: 3600,
      });
    }
    verifier = params.get("code_verifier")!;
    const id_token = await new SignJWT({ tid: m.tenant, oid, nonce })
      .setProtectedHeader({ alg: "RS256", kid: "local" })
      .setAudience(m.application)
      .setSubject(u.id)
      .setIssuer("https://login.microsoftonline.com/" + m.tenant + "/v2.0")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    return Response.json({
      access_token: "curto",
      refresh_token: "refresh-sintetico",
      id_token,
      expires_in: 10,
    });
  });
  const session = "sessao-de-teste";
  async function begin() {
    const url = new URL((await start(env, m, 1, u, session)).url);
    nonce = url.searchParams.get("nonce")!;
    const callback = new URL("https://example.test/api/microsoft/callback");
    callback.searchParams.set("code", "local");
    callback.searchParams.set("state", url.searchParams.get("state")!);
    return { url, callback };
  }
  const first = await begin();
  await assert.rejects(finish(env, m, 1, u, "outra-sessao", first.callback));
  oid = randomUUID();
  await assert.rejects(finish(env, m, 1, u, session, first.callback));
  assert.equal(sql.prepare("SELECT count(*) AS n FROM microsoft_tokens").get()?.n, 0);
  oid = u.entra_oid;
  const ok = await begin();
  await finish(env, m, 1, u, session, ok.callback);
  assert.equal(ok.url.searchParams.get("code_challenge_method"), "S256");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  assert.equal(
    ok.url.searchParams.get("code_challenge"),
    Buffer.from(digest).toString("base64url"),
  );
  await assert.rejects(finish(env, m, 1, u, session, ok.callback));
  const db = sql.prepare("SELECT encrypted FROM microsoft_tokens").get();
  assert.ok(db);
  assert.ok(!String(db.encrypted).includes("refresh-sintetico"));
  assert.equal(await access(env, m, 1, u), "renovado");
  assert.equal(await access(env, m, 1, u), "renovado");
  assert.equal(refreshes, 1);
  await assert.rejects(access(env, m, 2, u));
});
