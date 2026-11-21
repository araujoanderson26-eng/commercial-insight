import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import worker from "../worker/index";
import { digest } from "../worker/core";
import { nativePartStatements } from "../worker/native-model";
import { passwordHash } from "../shared/password.mjs";
import { sanitizeFilename, uint8ToBase64 } from "../src/lib/native-files";
import {
  clearNativeToken,
  hydrateNativeSession,
  registerNativeCleanup,
  resolveApiUrl,
  setNativeToken,
} from "../src/lib/runtime";
import { makeStore, plan } from "./fixtures";
import { fakeR2 } from "./manual-fixtures";
import { nativeFixture, nativeRows } from "./native-fixtures";

test("mobile runtime enforces HTTPS origins and avoids insecure web storage", async () => {
  assert.equal(resolveApiUrl("/me", { native: false }), "/api/me");
  assert.equal(
    resolveApiUrl("auth/login", {
      native: true,
      baseUrl: "https://commercial-insight.araujoempresarial.com.br/",
    }),
    "https://commercial-insight.araujoempresarial.com.br/api/auth/login",
  );
  assert.throws(
    () =>
      resolveApiUrl("me", {
        native: true,
        baseUrl: "http://commercial-insight.araujoempresarial.com.br",
      }),
    /HTTPS/,
  );
  assert.throws(() => resolveApiUrl("me", { native: true, baseUrl: "" }), /HTTPS/);

  let stored: string | null = null;
  let cleared = false;
  let cleanedFiles = 0;
  registerNativeCleanup(async () => {
    cleanedFiles++;
  });
  const fakePlugin = {
    async get() {
      return { value: stored };
    },
    async set(opts: { value: string }) {
      stored = opts.value;
    },
    async clear() {
      stored = null;
      cleared = true;
    },
  };

  const tokenHex = "a".repeat(64);
  await setNativeToken(tokenHex, fakePlugin, true);
  assert.equal(stored, tokenHex);
  const hydrated = await hydrateNativeSession(fakePlugin, true);
  assert.equal(hydrated, tokenHex);

  await clearNativeToken(fakePlugin);
  assert.equal(cleared, true);
  assert.equal(stored, null);
  assert.ok(cleanedFiles >= 1);

  assert.equal(
    sanitizeFilename(' Relatório: 2026/11 * Teste?.xlsx '),
    "Relatório-2026-11-Teste-.xlsx",
  );
  const encoded = uint8ToBase64(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
  assert.equal(Buffer.from(encoded, "base64").subarray(0, 2).toString(), "PK");
});

test("mobile API enforces MOBILE_ORIGINS, rotates Bearer sessions on refresh, and preserves ACLs", async (t) => {
  const s = makeStore();
  t.after(() => s.sql.close());

  s.env.BUCKET = fakeR2().bucket;
  s.env.MOBILE_ORIGINS = "capacitor://localhost,https://localhost";

  const pkg = nativeFixture();
  const version = randomUUID();
  s.sql
    .prepare(
      "INSERT INTO ci_imports(id,owner,actor,filename,bytes,sha256,object_key,status,base_generation,created,updated,published,manifest) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      version,
      "admin",
      "Admin Mobile Teste",
      "synthetic.ci.ndjson",
      pkg.data.length,
      pkg.sha256,
      "local",
      "published",
      0,
      1,
      1,
      1,
      JSON.stringify(pkg.manifest),
    );
  s.sql
    .prepare("UPDATE ci_sources SET source='manual',active_version_id=?,active_at=1,allow_ai=1")
    .run(version);
  for (const table of pkg.manifest.inventory.tables) {
    await s.env.DB.batch(
      nativePartStatements(
        s.env,
        pkg.manifest,
        version,
        table.id,
        nativeRows[table.id].map((values, i) => ({ row: i + 1, values })),
      ),
    );
  }

  const pw = "Senha Mobile Segura 2026";
  const hash = await passwordHash(pw);
  s.sql
    .prepare(
      "INSERT INTO users(id,email,name,password,role,national,regions,clients,update_only,active,created) VALUES(?,?,?,?,?,?,?,?,?,?,unixepoch())",
    )
    .run("admin", "admin@mobile.test", "Admin Mobile", hash, "admin", 1, "[]", "[]", 0, 1);
  s.sql
    .prepare(
      "INSERT INTO users(id,email,name,password,role,national,regions,clients,update_only,active,created) VALUES(?,?,?,?,?,?,?,?,?,?,unixepoch())",
    )
    .run("sales", "sales@mobile.test", "Comercial Mobile", hash, "comercial", 0, "[]", '["0001"]', 0, 1);
  s.sql
    .prepare(
      "INSERT INTO users(id,email,name,password,role,national,regions,clients,update_only,active,created) VALUES(?,?,?,?,?,?,?,?,?,?,unixepoch())",
    )
    .run("op", "op@mobile.test", "Operador Mobile", hash, "comercial", 0, "[]", "[]", 1, 1);

  const callMobile = (
    path: string,
    method: string,
    originHeader: string,
    token?: string,
    bodyPayload?: unknown,
  ) =>
    worker.fetch(
      new Request(s.env.APP_ORIGIN + "/api/" + path, {
        method,
        headers: {
          Origin: originHeader,
          "X-Client-Platform": "capacitor",
          ...(token ? { Authorization: "Bearer " + token } : {}),
          ...(bodyPayload !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(bodyPayload !== undefined ? { body: JSON.stringify(bodyPayload) } : {}),
      }),
      s.env,
      { waitUntil() {} } as unknown as ExecutionContext,
    );

  // Reject arbitrary / non-allowlisted origins
  const evil = await callMobile("auth/login", "POST", "https://evil.example", undefined, {
    email: "admin@mobile.test",
    password: pw,
  });
  assert.equal(evil.status, 403);
  const cleartextOrigin = await callMobile("auth/login", "POST", "http://localhost", undefined, {
    email: "admin@mobile.test",
    password: pw,
  });
  assert.equal(cleartextOrigin.status, 403);

  // Valid Android (https://localhost) login returns 64-hex Bearer token
  const loginAndroid = await callMobile("auth/login", "POST", "https://localhost", undefined, {
    email: "admin@mobile.test",
    password: pw,
  });
  assert.equal(loginAndroid.status, 200);
  const loginJson = (await loginAndroid.json()) as { ok: boolean; token?: string; expires?: number };
  assert.equal(loginJson.ok, true);
  assert.match(loginJson.token ?? "", /^[a-f0-9]{64}$/);
  assert.ok(typeof loginJson.expires === "number" && loginJson.expires > 0);
  const initialToken = loginJson.token!;

  // Deterministic query & visit succeed with Bearer token and 0 OpenAI calls
  const janFilters = { ...plan.filters, from: "2026-01", to: "2026-01" };
  const chatRes = await callMobile("chat", "POST", "https://localhost", initialToken, {
    question: "Quanto faturamos em 2026?",
    filters: janFilters,
    conversation: null,
  });
  assert.equal(chatRes.status, 200);
  const chatJson = (await chatRes.json()) as { meta: { engine: string; openaiCalls: number } };
  assert.equal(chatJson.meta.engine, "deterministic");
  assert.equal(chatJson.meta.openaiCalls, 0);

  // Refresh rotates token cleanly and invalidates old token immediately
  const refreshRes = await callMobile("auth/refresh", "POST", "https://localhost", initialToken, {});
  assert.equal(refreshRes.status, 200);
  const refreshJson = (await refreshRes.json()) as { ok: boolean; token?: string; expires?: number };
  assert.equal(refreshJson.ok, true);
  assert.match(refreshJson.token ?? "", /^[a-f0-9]{64}$/);
  assert.notEqual(refreshJson.token, initialToken);

  const oldRejected = await callMobile("me", "GET", "https://localhost", initialToken);
  assert.equal(oldRejected.status, 401);
  const newAccepted = await callMobile("me", "GET", "https://localhost", refreshJson.token);
  assert.equal(newAccepted.status, 200);

  // Scoped commercial user via iOS (capacitor://localhost) enforces ACL and blocks out-of-scope client
  const salesLogin = (await (
    await callMobile("auth/login", "POST", "capacitor://localhost", undefined, {
      email: "sales@mobile.test",
      password: pw,
    })
  ).json()) as { token: string };
  assert.equal(
    (
      await callMobile("visit", "POST", "capacitor://localhost", salesLogin.token, {
        ...janFilters,
        client: "0002",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await callMobile("visit", "POST", "capacitor://localhost", salesLogin.token, {
        ...janFilters,
        client: "0001",
      })
    ).status,
    200,
  );

  // Update operator blocked from analytics
  const opLogin = (await (
    await callMobile("auth/login", "POST", "https://localhost", undefined, {
      email: "op@mobile.test",
      password: pw,
    })
  ).json()) as { token: string };
  assert.equal(
    (
      await callMobile("report", "POST", "https://localhost", opLogin.token, {
        ...plan,
        filters: janFilters,
      })
    ).status,
    403,
  );

  // Revocation / logout immediately ends mobile session
  s.sql
    .prepare("UPDATE users SET version=version+1 WHERE id='admin'")
    .run();
  assert.equal(
    (await callMobile("me", "GET", "https://localhost", refreshJson.token)).status,
    401,
  );

  const logoutSales = await callMobile("auth/logout", "POST", "capacitor://localhost", salesLogin.token, {});
  assert.equal(logoutSales.status, 200);
  const hashedSales = await digest(salesLogin.token);
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM sessions WHERE hash=?").get(hashedSales)!.n, 0);
  assert.equal(
    (await callMobile("me", "GET", "capacitor://localhost", salesLogin.token)).status,
    401,
  );
});
