import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { Fact } from "../shared/manual";
import type { Report, Session } from "../shared/domain";
import { passwordHash } from "../shared/password.mjs";
import worker from "../worker/index";
import { makeStore, plan, filters } from "./fixtures";
import { fixtureManifest, testFacts } from "./manual-fixtures";

function seedVersion(sql: ReturnType<typeof makeStore>["sql"], owner: string, facts: Fact[]) {
  const id = randomUUID();
  const manifest = fixtureManifest();
  sql.prepare(
    "INSERT INTO ci_imports(id,owner,actor,filename,bytes,sha256,object_key,status,base_generation,rows,tables,manifest,created,updated,published) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,unixepoch(),unixepoch(),unixepoch())",
  ).run(
    id, owner, "Admin de teste", "SINTETICO.ci.ndjson", 1000,
    createHash("sha256").update(id).digest("hex"), "private-test/" + id,
    "published", 0, facts.length, 1, JSON.stringify(manifest),
  );
  const insert = sql.prepare(
    "INSERT INTO ci_facts(version_id,row_no,date,region,client,product,category,state,value) VALUES(?,?,?,?,?,?,?,?,?)",
  );
  for (const fact of facts) insert.run(
    id, fact.row, fact.date, fact.region, fact.client, fact.product, fact.category, fact.state,
    JSON.stringify({ revenue: Math.round(Number(fact.values.revenue) * 100) }),
  );
  return id;
}

test("API manual usa login próprio, limita relatórios e opções ao escopo e fixa a versão do chat e histórico", async (t) => {
  const { env, sql } = makeStore();
  t.after(() => sql.close());
  delete env.MS_CLIENT_SECRET;
  delete env.TOKEN_ENCRYPTION_KEY;
  const password = "Senha própria exclusiva para teste";
  const passwordValue = await passwordHash(password);
  const adminId = randomUUID(), managerId = randomUUID(), salesId = randomUUID();
  const createUser = sql.prepare(
    "INSERT INTO users(id,email,name,password,role,regions,clients,created) VALUES(?,?,?,?,?,?,?,unixepoch())",
  );
  createUser.run(adminId, "admin@provider.test", "Admin", passwordValue, "admin", "[]", "[]");
  createUser.run(managerId, "gerente@provider.test", "Gerente Sul", passwordValue, "gerente", '["Sul"]', "[]");
  createUser.run(salesId, "vendas@provider.test", "Vendas Sul", passwordValue, "comercial", '["Sul"]', '["0001"]');
  const first = seedVersion(sql, adminId, testFacts);
  const secondFacts = testFacts.map((fact) => ({
    ...fact,
    values: { revenue: fact.date.startsWith("2026") ? (fact.region === "Sul" ? "90.00" : "400.00") : fact.values.revenue },
  }));
  const second = seedVersion(sql, adminId, secondFacts);
  sql.prepare("UPDATE ci_sources SET source='manual',active_version_id=?,allow_ai=1,generation=1").run(first);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM settings").get()!.n, 0);
  const requests: { name: string; payload: Record<string, unknown> }[] = [];
  let replaceDuringInterpret = false;
  let maliciousRegion = false;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), "https://api.openai.com/v1/responses", "manual mode must never contact Microsoft");
    const request = JSON.parse(String(init?.body));
    assert.equal(request.store, false);
    const name = request.text.format.name;
    const payload = JSON.parse(request.input);
    requests.push({ name, payload });
    if (name === "plano_comercial" && replaceDuringInterpret)
      sql.prepare("UPDATE ci_sources SET active_version_id=?,generation=generation+1").run(second);
    const answer = name === "plano_comercial"
      ? { supported: true, reason: "", ...plan, filters: { ...filters, region: maliciousRegion ? "Norte" : "" } }
      : { summary: "O recorte da base semanal foi analisado.", actions: ["Conferir a carteira autorizada."] };
    return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(answer) }] }] });
  });
  async function request(path: string, method = "GET", value?: unknown, cookie = "", origin = env.APP_ORIGIN) {
    return worker.fetch(new Request(env.APP_ORIGIN + "/api/" + path, {
      method,
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: value === undefined ? undefined : JSON.stringify(value),
    }), env, { waitUntil() {} } as unknown as ExecutionContext);
  }
  async function login(email: string) {
    const response = await request("auth/login", "POST", { email, password });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("set-cookie")!, /HttpOnly/);
    return response.headers.get("set-cookie")!.split(";")[0];
  }
  const manager = await login("gerente@provider.test");
  const sales = await login("vendas@provider.test");
  const admin = await login("admin@provider.test");
  const me = await (await request("me", "GET", undefined, manager)).json() as Session;
  assert.equal(me.integrations.configured, false);
  assert.equal(me.integrations.linked, false);
  assert.equal(me.data?.source, "manual");
  assert.equal(me.data?.ready, true);
  assert.equal(me.data?.activeVersionId, first);
  assert.equal((await request("data/status")).status, 401);
  assert.equal((await request("admin/data", "GET", undefined, manager)).status, 403);
  for (const path of ["admin/data/imports", `admin/data/imports/${first}/complete`, `admin/data/imports/${first}/retry`, "admin/data/restore"])
    assert.equal((await request(path, "POST", {}, sales)).status, 403, path);
  assert.equal((await request(`admin/data/imports/${first}/package`, "GET", undefined, sales)).status, 403);
  assert.equal((await request("admin/data/settings", "PUT", { source: "manual", staleDays: 7, allowAI: true }, admin, "https://other.test")).status, 403);
  assert.equal((await request("admin/data", "GET", undefined, admin)).status, 200);

  const scopedResponse = await request("report", "POST", { ...plan, group: "client" }, manager);
  assert.equal(scopedResponse.status, 200);
  assert.match(scopedResponse.headers.get("cache-control")!, /private, no-store/);
  const scoped = await scopedResponse.json() as Report;
  assert.equal(scoped.total.values.revenue.current, 30);
  assert.equal(scoped.total.values.revenue.previous, 10);
  assert.equal(scoped.total.values.margin.current, null);
  assert.deepEqual(scoped.rows.map((row) => row.name), ["0001"]);
  assert.equal(scoped.source, "Arquivo manual (D1)");
  assert.equal(scoped.sourceInfo?.versionId, first);
  assert.equal(scoped.sourceInfo?.extractedAt, "2026-11-18T12:00:00Z");
  assert.deepEqual(scoped.sourceInfo?.coverage, { from: "2025-01-01", to: "2026-01-01" });
  for (const badFilter of [{ region: "Norte" }, { client: "0002" }])
    assert.equal((await request("report", "POST", { ...plan, filters: { ...filters, ...badFilter } }, sales)).status, 403);
  const optionsResponse = await request("data/options", "POST", filters, manager);
  assert.equal(optionsResponse.status, 200);
  const options = await optionsResponse.json() as { values: Record<string, string[]>; sourceVersion: string };
  assert.equal(options.sourceVersion, first);
  assert.deepEqual(options.values, { region: ["Sul"], client: ["0001"], product: ["P"] });
  assert.equal((await request("data/options", "POST", { ...filters, region: "Norte" }, manager)).status, 403);
  assert.equal((await request("report", "POST", { ...plan, metric: "margin" }, manager)).status, 422);
  assert.equal(requests.length, 0, "D1 reports and unavailable metrics need no external calls");

  replaceDuringInterpret = true;
  const chatResponse = await request("chat", "POST", { question: "Analise meu faturamento", filters, conversation: null }, manager);
  assert.equal(chatResponse.status, 200);
  const chat = await chatResponse.json() as { id: string; turn: string; report: Report; commentary: { actions: string[] } };
  assert.equal(chat.report.sourceInfo?.versionId, first, "provider must pin snapshot before the AI request");
  assert.equal(chat.report.total.values.revenue.current, 30);
  const interpretation = requests.find((entry) => entry.name === "leitura_comercial")!.payload;
  assert.equal((interpretation.sourceInfo as Report["sourceInfo"])?.versionId, first);
  assert.deepEqual(interpretation.rows, [{ name: "2026-01", current: 30, previous: 10 }, { name: "2026-02", current: null, previous: null }, { name: "2026-03", current: null, previous: null }]);
  const serializedAI = JSON.stringify(requests);
  assert.doesNotMatch(serializedAI, /"0002"|"Norte"/);
  assert.equal((interpretation.totals as Report["total"]["values"]).revenue.current, 30);
  assert.equal("facts" in interpretation, false);
  const saved = sql.prepare("SELECT source_type,source_version FROM turns WHERE id=?").get(chat.turn)!;
  assert.equal(saved.source_type, "manual");
  assert.equal(saved.source_version, first);
  const newer = await (await request("report", "POST", plan, manager)).json() as Report;
  assert.equal(newer.sourceInfo?.versionId, second);
  assert.equal(newer.total.values.revenue.current, 90);
  sql.exec("UPDATE ci_sources SET source='powerbi'");
  const reopenedResponse = await request(`turns/${chat.turn}/reopen`, "POST", {}, manager);
  assert.equal(reopenedResponse.status, 200);
  const reopened = await reopenedResponse.json() as typeof chat;
  assert.equal(reopened.report.sourceInfo?.versionId, first);
  assert.equal(reopened.report.total.values.revenue.current, 30);
  assert.equal(reopened.commentary.actions.length, 1);
  assert.equal((await request(`turns/${chat.turn}/reopen`, "POST", {}, sales)).status, 404);
  assert.equal((await request(`conversations/${chat.id}`, "GET", undefined, sales)).status, 404);
  assert.equal((await request("report", "POST", plan, manager)).status, 409, "online source without configuration must fail explicitly");
  sql.exec("UPDATE ci_sources SET source='manual'");
  replaceDuringInterpret = false;
  maliciousRegion = true;
  const previousComments = requests.filter((entry) => entry.name === "leitura_comercial").length;
  assert.equal((await request("chat", "POST", { question: "Veja a regional Norte", filters, conversation: null }, manager)).status, 403);
  assert.equal(requests.filter((entry) => entry.name === "leitura_comercial").length, previousComments);
  sql.exec("UPDATE ci_sources SET allow_ai=0");
  const beforeAI = requests.length;
  assert.equal((await request("chat", "POST", { question: "Analise meu faturamento", filters, conversation: null }, manager)).status, 409);
  assert.equal(requests.length, beforeAI, "AI authorization must be enforced before sending context");
  assert.equal((await request("me", "GET", undefined, manager)).status, 200, "publishing snapshots preserves own login");
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM users").get()!.n, 3);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM microsoft_tokens").get()!.n, 0);
  assert.equal(sql.prepare("SELECT regions FROM users WHERE id=?").get(managerId)!.regions, '["Sul"]');
});

test("base manual sem versão válida responde estado vazio e não retorna indicadores de demonstração", async (t) => {
  const { env, sql } = makeStore();
  t.after(() => sql.close());
  sql.exec("UPDATE ci_sources SET source='manual'");
  const userId = randomUUID();
  const secret = "1".repeat(64);
  const hashed = createHash("sha256").update(secret).digest("hex");
  sql.prepare("INSERT INTO users(id,email,name,password,role,created) VALUES(?,?,?,?,?,unixepoch())").run(userId, "empty@provider.test", "Admin", "test", "admin");
  sql.prepare("INSERT INTO sessions(hash,user_id,version,expires,seen) VALUES(?,?,1,unixepoch()+3600,unixepoch())").run(hashed, userId);
  const call = (path: string, method = "GET", value?: unknown) => worker.fetch(new Request(env.APP_ORIGIN + "/api/" + path, {
    method, headers: { Origin: env.APP_ORIGIN, Cookie: "__Host-ci=" + secret, "Content-Type": "application/json" },
    body: value === undefined ? undefined : JSON.stringify(value),
  }), env, {} as ExecutionContext);
  t.mock.method(globalThis, "fetch", async () => { throw Error("No provider should be contacted without an active manual version"); });
  const me = await (await call("me")).json() as Session;
  assert.equal(me.data?.ready, false);
  assert.equal(me.data?.activeVersionId, null);
  const report = await call("report", "POST", plan);
  assert.equal(report.status, 409);
  const result = await report.json() as Record<string, unknown>;
  assert.equal("total" in result, false);
  assert.equal("rows" in result, false);
  assert.match(String(result.error), /Nenhuma base manual válida/);
});

test("carteira e regional são uma interseção na API e escopo nacional exige papel autorizado", async (t) => {
  const { env, sql } = makeStore();
  t.after(() => sql.close());
  const userId = randomUUID(), secret = "2".repeat(64);
  sql.prepare("INSERT INTO users(id,email,name,password,role,national,regions,clients,created) VALUES(?,?,?,?,?,1,?,?,unixepoch())")
    .run(userId, "intersection@provider.test", "Comercial", "test", "comercial", '["Sul"]', '["0001"]');
  sql.prepare("INSERT INTO sessions(hash,user_id,version,expires,seen) VALUES(?,?,1,unixepoch()+3600,unixepoch())")
    .run(createHash("sha256").update(secret).digest("hex"), userId);
  const facts = [
    ["Sul", "0001", "1.00"], ["Norte", "0001", "100.00"],
    ["Sul", "0002", "200.00"], ["Norte", "0002", "1000.00"],
  ].map(([region, client, revenue], index): Fact => ({
    row: index + 1, date: "2026-01-01", region, client, product: "P", category: "C", state: "SP", values: { revenue },
  }));
  const version = seedVersion(sql, userId, facts);
  sql.prepare("UPDATE ci_sources SET source='manual',active_version_id=?").run(version);
  const request = (path: string, value: unknown) => worker.fetch(new Request(env.APP_ORIGIN + "/api/" + path, {
    method: "POST", headers: { Origin: env.APP_ORIGIN, Cookie: "__Host-ci=" + secret, "Content-Type": "application/json" }, body: JSON.stringify(value),
  }), env, {} as ExecutionContext);
  const response = await request("report", { ...plan, group: "client" });
  assert.equal(response.status, 200);
  const report = await response.json() as Report;
  assert.equal(report.total.values.revenue.current, 1);
  assert.deepEqual(report.rows.map((row) => row.name), ["0001"]);
  const options = await (await request("data/options", filters)).json() as { values: Record<string, string[]> };
  assert.deepEqual(options.values, { region: ["Sul"], client: ["0001"], product: ["P"] });
  sql.prepare("UPDATE users SET regions='[]',clients='[]' WHERE id=?").run(userId);
  assert.equal((await request("report", plan)).status, 403, "national flag on a commercial role does not grant national access");
});

test("opções não retornam nomes quando o escopo é revogado durante a consulta", async (t) => {
  const { env, sql } = makeStore();
  t.after(() => sql.close());
  const userId = randomUUID(), secret = "3".repeat(64);
  sql.prepare("INSERT INTO users(id,email,name,password,role,regions,clients,created) VALUES(?,?,?,?,?,?,?,unixepoch())")
    .run(userId, "revoked-options@provider.test", "Gerente sintético", "test", "gerente", '["Sul"]', "[]");
  sql.prepare("INSERT INTO sessions(hash,user_id,version,expires,seen) VALUES(?,?,1,unixepoch()+3600,unixepoch())")
    .run(createHash("sha256").update(secret).digest("hex"), userId);
  const version = seedVersion(sql, userId, testFacts);
  sql.prepare("UPDATE ci_sources SET source='manual',active_version_id=?").run(version);
  const originalPrepare = env.DB.prepare.bind(env.DB);
  let revoked = false;
  t.mock.method(env.DB, "prepare", (text: string) => {
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...args: (string | number | null)[]) => wrap(target.bind(...args));
        if (property === "all") return async () => {
          const result = await target.all();
          if (!revoked && text.startsWith("SELECT DISTINCT region AS value FROM ci_facts")) {
            revoked = true;
            sql.prepare("UPDATE users SET regions='[\"Norte\"]',version=version+1,scope_version=scope_version+1 WHERE id=?").run(userId);
          }
          return result;
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return wrap(originalPrepare(text));
  });
  const response = await worker.fetch(new Request(env.APP_ORIGIN + "/api/data/options", {
    method: "POST", headers: { Origin: env.APP_ORIGIN, Cookie: "__Host-ci=" + secret, "Content-Type": "application/json" }, body: JSON.stringify(filters),
  }), env, {} as ExecutionContext);
  assert.equal(revoked, true, "revocation must occur after an authorized options query starts");
  assert.equal(response.status, 403);
  const payload = await response.json() as Record<string, unknown>;
  assert.match(String(payload.error), /acesso mudou durante a consulta/i);
  assert.equal("values" in payload, false);
  assert.doesNotMatch(JSON.stringify(payload), /0001|Sul|Norte/);
});

test("opções limitam consultas caras antes da SQL e isolam a cota por usuário", async (t) => {
  const fixedNow = Date.now();
  t.mock.method(Date, "now", () => fixedNow);
  const { env, sql } = makeStore();
  t.after(() => sql.close());
  const identities = ["4", "5"].map((digit) => ({ id: randomUUID(), secret: digit.repeat(64) }));
  for (const identity of identities) {
    sql.prepare("INSERT INTO users(id,email,name,password,role,regions,clients,created) VALUES(?,?,?,?,?,?,?,unixepoch())")
      .run(identity.id, identity.id + "@limited-options.test", "Gerente sintético", "test", "gerente", '["Sul"]', "[]");
    sql.prepare("INSERT INTO sessions(hash,user_id,version,expires,seen) VALUES(?,?,1,unixepoch()+3600,unixepoch())")
      .run(createHash("sha256").update(identity.secret).digest("hex"), identity.id);
  }
  const version = seedVersion(sql, identities[0].id, testFacts);
  sql.prepare("UPDATE ci_sources SET source='manual',active_version_id=?").run(version);
  const originalPrepare = env.DB.prepare.bind(env.DB);
  let optionsQueries = 0;
  t.mock.method(env.DB, "prepare", (text: string) => {
    if (text.startsWith("SELECT DISTINCT region AS value FROM ci_facts")) optionsQueries++;
    return originalPrepare(text);
  });
  const request = (secret: string) => worker.fetch(new Request(env.APP_ORIGIN + "/api/data/options", {
    method: "POST", headers: { Origin: env.APP_ORIGIN, Cookie: "__Host-ci=" + secret, "Content-Type": "application/json" }, body: JSON.stringify(filters),
  }), env, {} as ExecutionContext);
  for (let index = 0; index < 30; index++) assert.equal((await request(identities[0].secret)).status, 200);
  assert.equal(optionsQueries, 30);
  const blocked = await request(identities[0].secret);
  assert.equal(blocked.status, 429);
  assert.equal(optionsQueries, 30, "a blocked request must not prepare the costly options query");
  assert.equal((await request(identities[1].secret)).status, 200);
  assert.equal(optionsQueries, 31, "another owner keeps an independent quota");
});

for (const revokeAt of ["plano_comercial", "leitura_comercial"] as const) {
  test(`revogar IA durante ${revokeAt} interrompe o chat sem persistir a resposta`, async (t) => {
    const { env, sql } = makeStore();
    t.after(() => sql.close());
    const userId = randomUUID(), secret = "6".repeat(64);
    sql.prepare("INSERT INTO users(id,email,name,password,role,regions,clients,created) VALUES(?,?,?,?,?,?,?,unixepoch())")
      .run(userId, "revoked-ai@provider.test", "Gerente sintético", "test", "gerente", '["Sul"]', "[]");
    sql.prepare("INSERT INTO sessions(hash,user_id,version,expires,seen) VALUES(?,?,1,unixepoch()+3600,unixepoch())")
      .run(createHash("sha256").update(secret).digest("hex"), userId);
    const version = seedVersion(sql, userId, testFacts);
    sql.prepare("UPDATE ci_sources SET source='manual',active_version_id=?,allow_ai=1").run(version);
    const outbound: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(String(input), "https://api.openai.com/v1/responses");
      const name = JSON.parse(String(init?.body)).text.format.name as string;
      outbound.push(name);
      if (name === revokeAt) sql.exec("UPDATE ci_sources SET allow_ai=0");
      const answer = name === "plano_comercial"
        ? { supported: true, reason: "", ...plan }
        : { summary: "Interpretação sintética.", actions: [] };
      return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(answer) }] }] });
    });
    const response = await worker.fetch(new Request(env.APP_ORIGIN + "/api/chat", {
      method: "POST", headers: { Origin: env.APP_ORIGIN, Cookie: "__Host-ci=" + secret, "Content-Type": "application/json" },
      body: JSON.stringify({ question: "Analise meu faturamento", filters, conversation: null }),
    }), env, {} as ExecutionContext);
    assert.equal(response.status, 409);
    const payload = await response.json() as Record<string, unknown>;
    assert.match(String(payload.error), /OpenAI|IA|habilit|autoriz/i);
    assert.deepEqual(outbound, revokeAt === "plano_comercial" ? ["plano_comercial"] : ["plano_comercial", "leitura_comercial"]);
    assert.equal("report" in payload, false);
    assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM turns").get()!.n, 0);
    assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM conversations").get()!.n, 0);
  });
}
