import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import worker from "../worker/index";
import { passwordHash } from "../shared/password.mjs";
import { biRows, filters, makeStore, model, plan } from "./fixtures";
test("fluxo integrado da API com SQLite e provedores controlados", async (t) => {
  const { env, sql } = makeStore();
  t.after(() => sql.close());
  const pw = "Uma senha exclusiva de teste",
    hash = await passwordHash(pw),
    adminId = randomUUID(),
    salesId = randomUUID();
  const seed = sql.prepare(
    "INSERT INTO users(id,email,name,password,role,clients,created) VALUES(?,?,?,?,?,?,unixepoch())",
  );
  seed.run(adminId, "admin@example.test", "Admin de teste", hash, "admin", "[]");
  seed.run(
    salesId,
    "comercial@example.test",
    "Vendas de teste",
    hash,
    "comercial",
    '["Loja teste"]',
  );
  let gross = 120,
    resetToken = "",
    asked = 0,
    pbi = 0;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("api.resend.com")) {
      resetToken = JSON.parse(String(init?.body)).text.match(/#([a-f0-9]{64})/)[1];
      return Response.json({ id: randomUUID() });
    }
    if (url.includes("login.microsoftonline.com"))
      return Response.json({ access_token: "access-test", expires_in: 3600 });
    if (url.includes("api.powerbi.com")) {
      pbi++;
      assert.ok(url.endsWith("/executeQueries"));
      const query = JSON.parse(String(init?.body)).queries[0].query;
      assert.match(query, /EVALUATE/);
      return Response.json(biRows(gross));
    }
    assert.equal(url, "https://api.openai.com/v1/responses");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.store, false);
    asked++;
    const answer =
      body.text.format.name === "plano_comercial"
        ? { supported: true, reason: "", ...plan }
        : { summary: "O faturamento cresceu no recorte.", actions: ["Revisar a carteira."] };
    return Response.json({
      status: "completed",
      output: [
        { type: "message", content: [{ type: "output_text", text: JSON.stringify(answer) }] },
      ],
    });
  });
  const jobs: Promise<unknown>[] = [];
  async function request(
    path: string,
    method = "GET",
    value?: unknown,
    cookie = "",
    origin = env.APP_ORIGIN,
  ) {
    const response = await worker.fetch(
      new Request(env.APP_ORIGIN + "/api/" + path, {
        method,
        headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
        body: value === undefined ? undefined : JSON.stringify(value),
      }),
      env,
      { waitUntil: (job: Promise<unknown>) => jobs.push(job) } as unknown as ExecutionContext,
    );
    await Promise.all(jobs.splice(0));
    return response;
  }
  async function login(email: string, password = pw) {
    const r = await request("auth/login", "POST", { email, password });
    assert.equal(r.status, 200);
    const c = r.headers.get("set-cookie")!;
    assert.match(c, /HttpOnly/);
    assert.match(c, /Secure/);
    return c.split(";")[0];
  }
  const admin = await login("admin@example.test"),
    sales = await login("comercial@example.test");
  assert.equal((await request("me")).status, 401);
  assert.equal((await request("admin/config", "GET", undefined, sales)).status, 403);
  assert.equal(
    (await request("admin/config", "PUT", { model, revision: 0 }, admin, "https://another.test"))
      .status,
    403,
  );
  assert.equal((await request("admin/config", "PUT", { model, revision: 0 }, admin)).status, 200);
  assert.equal((await request("admin/config", "PUT", { model, revision: 0 }, admin)).status, 409);
  assert.equal(
    (
      await request(
        "report",
        "POST",
        { ...plan, filters: { ...filters, client: "Outra loja" } },
        sales,
      )
    ).status,
    403,
  );
  assert.equal(pbi, 0);
  const r = await request(
    "chat",
    "POST",
    { question: "Como está o faturamento?", conversation: null, filters },
    sales,
  );
  assert.equal(r.status, 200);
  assert.match(r.headers.get("cache-control")!, /no-store/);
  const chat = (await r.json()) as {
    id: string;
    turn: string;
    report: { total: { values: { revenue: { current: number } } } };
  };
  assert.equal(chat.report.total.values.revenue.current, 120);
  assert.equal(asked, 2);
  assert.equal((await request("conversations/" + chat.id, "GET", undefined, admin)).status, 404);
  assert.equal((await request("turns/" + chat.turn + "/reopen", "POST", {}, admin)).status, 404);
  const again = (await (
    await request("turns/" + chat.turn + "/reopen", "POST", {}, sales)
  ).json()) as { commentary: { actions: string[] } };
  assert.equal(again.commentary.actions.length, 1);
  gross = 140;
  const updated = (await (
    await request("turns/" + chat.turn + "/reopen", "POST", {}, sales)
  ).json()) as typeof again;
  assert.equal(updated.commentary.actions.length, 0);
  assert.equal(
    (await request("auth/forgot", "POST", { email: "comercial@example.test" })).status,
    200,
  );
  assert.equal(
    (
      await request("auth/reset", "POST", {
        token: resetToken,
        password: "Nova senha comercial segura",
      })
    ).status,
    200,
  );
  assert.equal(
    (await request("auth/reset", "POST", { token: resetToken, password: pw })).status,
    400,
  );
  assert.equal((await request("me", "GET", undefined, sales)).status, 401);
  const renewed = await login("comercial@example.test", "Nova senha comercial segura");
  const u = (await (await request("me", "GET", undefined, renewed)).json()) as {
    user: Record<string, unknown>;
  };
  const { id, ...rest } = u.user;
  assert.equal(
    (
      await request(
        "admin/users/" + id,
        "PUT",
        { user: { ...rest, clients: ["Outra loja"] } },
        admin,
      )
    ).status,
    200,
  );
  assert.equal((await request("me", "GET", undefined, renewed)).status, 401);
  const newer = await login("comercial@example.test", "Nova senha comercial segura");
  assert.deepEqual(await (await request("conversations", "GET", undefined, newer)).json(), []);
  assert.equal((await request("auth/logout", "POST", {}, newer)).status, 200);
  assert.equal((await request("me", "GET", undefined, newer)).status, 401);
});
