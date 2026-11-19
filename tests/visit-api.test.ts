import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/index";
import { passwordHash } from "../shared/password.mjs";
import { nativePartStatements } from "../worker/native-model";
import type { VisitBriefing } from "../shared/commercial";
import type { Report } from "../shared/domain";
import { makeStore } from "./fixtures";
import { nativeFixture } from "./native-fixtures";

test("chat prepara visita com dados D1 autorizados, reabre briefing no snapshot original e nega carteira alheia", async t => {
  const { env, sql } = makeStore();
  t.after(() => sql.close());
  const id = crypto.randomUUID(), version = crypto.randomUUID();
  const pkg = nativeFixture();
  const password = "Uma senha exclusiva para visitas de teste";
  sql.prepare("INSERT INTO users(id,email,name,password,role,regions,clients,created) VALUES(?,?,?,?,?,?,?,unixepoch())")
    .run(id, "visitas@example.test", "Representante autorizado", await passwordHash(password), "comercial", '["Rep A"]', '["0001"]');
  sql.prepare("INSERT INTO ci_imports(id,owner,actor,filename,bytes,sha256,object_key,status,base_generation,created,updated,published,manifest) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(version, id, "Operador de teste", "SINTETICO.ci.ndjson", pkg.data.length, pkg.sha256, "private-test", "published", 0, 1, 1, 1, JSON.stringify(pkg.manifest));
  sql.prepare("UPDATE ci_sources SET source='manual',active_version_id=?,allow_ai=1,active_at=1").run(version);
  for (const table of pkg.manifest.inventory.tables) {
    const rows = pkg.rows[table.id].map((values, index) => ({ row: index + 1, values }));
    await env.DB.batch(nativePartStatements(env, pkg.manifest, version, table.id, rows));
  }
  let aiCalls = 0;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), "https://api.openai.com/v1/responses");
    aiCalls++;
    const request = JSON.parse(String(init?.body));
    const answer = request.text.format.name === "plano_comercial"
      ? { supported: true, reason: "", inheritContext: false, metric: "revenue", group: "month", order: "current", filters: { from: "2026-01", to: "2026-01", client: "0001", region: "", product: "" } }
      : { summary: "A reunião deve revisar o histórico do cliente e as devoluções observadas.", actions: ["Confirmar as causas comerciais na visita."] };
    return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(answer) }] }] });
  });
  async function request(path: string, value?: unknown, cookie = "") {
    return worker.fetch(new Request(env.APP_ORIGIN + "/api/" + path, {
      method: value === undefined ? "GET" : "POST", headers: { Origin: env.APP_ORIGIN, Cookie: cookie, "Content-Type": "application/json" },
      body: value === undefined ? undefined : JSON.stringify(value),
    }), env, { waitUntil() {} } as unknown as ExecutionContext);
  }
  const login = await request("auth/login", { email: "visitas@example.test", password });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const filters = { from: "2026-01", to: "2026-01", client: "0001", region: "", product: "" };
  const chatResponse = await request("chat", { question: "Vou visitar o cliente 0001 amanhã. Prepare minha reunião.", conversation: null, filters }, cookie);
  assert.equal(chatResponse.status, 200, await chatResponse.clone().text());
  const chat = await chatResponse.json() as { id: string; turn: string; report: Report; visit: VisitBriefing };
  assert.equal(chat.visit.client.code, "0001");
  assert.equal(chat.visit.timeline.total.values.revenue.current, 135);
  assert.equal(chat.visit.timeline.total.values.revenue.previous, 90);
  assert.equal(chat.visit.timeline.sourceInfo?.versionId, version);
  assert.equal(chat.visit.activity.lastPurchase, "2026-01-02");
  assert.equal(chat.visit.activity.purchaseDays, 2);
  assert.equal(chat.visit.client.municipality, null, "município cadastral não existe no modelo sintético");
  assert.equal(chat.visit.products.rows.every(row => ["P", "Q"].includes(row.key ?? row.name)), true);
  assert.equal(aiCalls, 2);
  assert.match(sql.prepare("SELECT answer FROM turns WHERE id=?").get(chat.turn)!.answer as string, /"visit"/);
  const legacy = JSON.parse(sql.prepare("SELECT answer FROM turns WHERE id=?").get(chat.turn)!.answer as string);
  legacy.summary = "Fato verificado: Faturamento de R$ 135,00. A interpretação automática não foi aproveitada; causas comerciais precisam ser confirmadas.";
  sql.prepare("UPDATE turns SET answer=? WHERE id=?").run(JSON.stringify(legacy), chat.turn);
  sql.prepare("UPDATE ci_sources SET allow_ai=0").run();
  const reopenedResponse = await request(`turns/${chat.turn}/reopen`, {}, cookie);
  assert.equal(reopenedResponse.status, 200);
  const reopened = await reopenedResponse.json() as { visit: VisitBriefing; commentary: { summary: string } };
  assert.equal(reopened.visit.timeline.sourceInfo?.versionId, version);
  assert.equal(reopened.visit.timeline.total.values.revenue.current, 135);
  assert.notEqual(reopened.commentary.summary, legacy.summary, "reabrir atualiza apenas a apresentação factual calculada");
  assert.match(reopened.commentary.summary, /bruto/iu);
  assert.equal(JSON.parse(sql.prepare("SELECT answer FROM turns WHERE id=?").get(chat.turn)!.answer as string).summary, legacy.summary, "a resposta gravada permanece imutável");
  assert.equal(aiCalls, 2, "reabrir visita é reconsulta tipada, sem OpenAI");
  const forbidden = await request("visit", { ...filters, client: "0002" }, cookie);
  assert.equal(forbidden.status, 403);
  const noClient = await request("visit", { ...filters, client: "" }, cookie);
  assert.equal(noClient.status, 422);
});
