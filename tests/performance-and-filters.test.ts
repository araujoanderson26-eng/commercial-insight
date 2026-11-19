import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { DataCapabilities, Filters, Plan, Report, Row } from "../shared/domain";
import { passwordHash } from "../shared/password.mjs";
import { filterRowsLocally, projectCompatibleReport } from "../src/lib/analytics";
import {
  activeFilterChips,
  buildFilterSearch,
  parseFiltersFromSearch,
  sanitizeFiltersForCapabilities,
} from "../src/lib/filter-state";
import { digest } from "../worker/core";
import worker from "../worker/index";
import { nativePartStatements } from "../worker/native-model";
import { makeStore, plan } from "./fixtures";
import { fakeR2 } from "./manual-fixtures";
import { nativeFixture, nativeRows } from "./native-fixtures";

function makeRow(name: string, revCurr: number, revPrev: number, grossCurr: number, key = name): Row {
  return {
    key,
    name,
    values: {
      revenue: { current: revCurr, previous: revPrev },
      gross: { current: grossCurr, previous: grossCurr - 10 },
      returns: { current: grossCurr - revCurr, previous: 5 },
      buyers: { current: 5, previous: 4 },
      margin: { current: null, previous: null },
    },
  };
}

test("projectCompatibleReport reuses monthly series and non-truncated rankings in memory", () => {
  const baseFilters: Filters = { ...plan.filters, from: "2026-01", to: "2026-02" };
  const monthReport: Report = {
    total: makeRow("Total", 300, 200, 330),
    rows: [makeRow("2026-01", 100, 80, 110), makeRow("2026-02", 200, 120, 220)],
    plan: { group: "month", metric: "revenue", order: "current", filters: baseFilters },
    asOf: "2026-11-19T12:00:00Z",
    truncated: false,
    source: "Arquivo manual (D1)",
  };
  const monthGrossPlan: Plan = { ...monthReport.plan, metric: "gross" };
  const projectedMonth = projectCompatibleReport(monthGrossPlan, [monthReport]);
  assert.ok(projectedMonth);
  assert.equal(projectedMonth.plan.metric, "gross");
  assert.equal(projectedMonth.rows[1].values.gross.current, 220);

  const clientReport: Report = {
    total: makeRow("Total", 300, 200, 350),
    rows: [
      makeRow("Cliente A", 200, 250, 210, "A"),
      makeRow("Cliente B", 100, 20, 400, "B"),
    ],
    plan: { group: "client", metric: "revenue", order: "current", filters: baseFilters },
    asOf: "2026-11-19T12:00:00Z",
    truncated: false,
    source: "Arquivo manual (D1)",
  };
  const growthPlan: Plan = { group: "client", metric: "revenue", order: "growth", filters: baseFilters };
  const projectedGrowth = projectCompatibleReport(growthPlan, [clientReport]);
  assert.ok(projectedGrowth);
  assert.equal(projectedGrowth.rows[0].key, "B");

  const grossPlan: Plan = { group: "client", metric: "gross", order: "current", filters: baseFilters };
  const projectedGross = projectCompatibleReport(grossPlan, [clientReport]);
  assert.ok(projectedGross);
  assert.equal(projectedGross.rows[0].key, "B");

  const truncatedClientReport: Report = { ...clientReport, truncated: true };
  assert.equal(projectCompatibleReport(grossPlan, [truncatedClientReport]), null);
  assert.ok(projectCompatibleReport(clientReport.plan, [truncatedClientReport]));
});

test("filterRowsLocally performs accent-insensitive matching across name, key and description", () => {
  const rows: Row[] = [
    { ...makeRow("0012 — São Lourenço Açúcar", 100, 90, 110, "0012"), description: "São Lourenço Açúcar" },
    { ...makeRow("0099 — Mercado Central", 80, 70, 85, "0099"), description: "Mercado Central" },
  ];
  assert.equal(filterRowsLocally(rows, "sao lourenco acucar").length, 1);
  assert.equal(filterRowsLocally(rows, "0099").length, 1);
  assert.equal(filterRowsLocally(rows, "inexistente").length, 0);
});

test("filter-state handles URL serialization, invalid fallback, capability sanitization and chips", () => {
  const supported = ["region", "client", "category"] as const;
  const parsed = parseFiltersFromSearch(
    "?from=2026-01&to=2026-06&client=0001&state=RS&catIn=SUCO|VINHO&catEx=GRANEL",
    supported,
  );
  assert.ok(parsed);
  assert.equal(parsed.from, "2026-01");
  assert.equal(parsed.to, "2026-06");
  assert.equal(parsed.client, "0001");
  assert.equal(parsed.state, undefined);
  assert.deepEqual(parsed.categoriesInclude, ["SUCO", "VINHO"]);
  assert.deepEqual(parsed.categoriesExclude, ["GRANEL"]);

  assert.equal(parseFiltersFromSearch("?from=invalido&to=2026-06", supported), null);

  const sanitized = sanitizeFiltersForCapabilities(
    { from: "2026-01", to: "2026-06", region: "Rep A", client: "", product: "", state: "SP", manager: "G1" },
    ["region", "client"],
  );
  assert.equal(sanitized.state, undefined);
  assert.equal(sanitized.manager, undefined);
  assert.equal(sanitized.region, "Rep A");

  const search = buildFilterSearch(parsed);
  assert.match(search, /client=0001/);
  assert.match(search, /catIn=SUCO%7CVINHO/);

  const caps: DataCapabilities = {
    metrics: ["revenue"],
    groups: ["month", "client"],
    filters: ["region", "client", "category"],
    labels: { region: "Representante" },
  };
  const chips = activeFilterChips(parsed, caps, { client: { "0001": "0001 — Cliente Exemplo" } });
  assert.equal(chips.length, 4);
  assert.equal(chips[0].value, "0001 — Cliente Exemplo");
  const afterRemove = chips[0].remove(parsed);
  assert.equal(afterRemove.client, "");
});

async function setupWorkerWithNative() {
  const store = makeStore();
  const pkg = nativeFixture();
  const version = randomUUID();
  store.env.BUCKET = fakeR2().bucket;
  store.sql
    .prepare(
      "INSERT INTO ci_imports(id,owner,actor,filename,bytes,sha256,object_key,status,base_generation,created,updated,published,manifest) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      version,
      "admin",
      "Admin Teste",
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
  store.sql
    .prepare("UPDATE ci_sources SET source='manual',active_version_id=?,active_at=1,allow_ai=0")
    .run(version);
  for (const table of pkg.manifest.inventory.tables) {
    await store.env.DB.batch(
      nativePartStatements(
        store.env,
        pkg.manifest,
        version,
        table.id,
        nativeRows[table.id].map((values, i) => ({ row: i + 1, values })),
      ),
    );
  }
  const pw = "Senha de teste segura 123";
  const hash = await passwordHash(pw);
  store.sql
    .prepare("INSERT INTO users(id,email,name,password,role,national,created) VALUES(?,?,?,?,?,?,unixepoch())")
    .run("admin", "admin@example.test", "Admin Teste", hash, "admin", 1);

  const rawCookie = randomUUID().replaceAll("-", "").repeat(2);
  store.sql
    .prepare("INSERT INTO sessions(hash,user_id,version,expires,seen) VALUES(?,?,1,unixepoch()+3600,unixepoch())")
    .run(await digest(rawCookie), "admin");
  const cookie = "__Host-ci=" + rawCookie;
  return { ...store, pw, cookie, version };
}

test("Worker Edge Cache returns MISS then HIT with Server-Timing and invalidates on scope or session revocation", async (t) => {
  const s = await setupWorkerWithNative();
  t.after(() => s.sql.close());

  const originalCaches = (globalThis as { caches?: unknown }).caches;
  const map = new Map<string, Response>();
  (globalThis as { caches?: unknown }).caches = {
    default: {
      async match(req: Request) {
        const res = map.get(req.url);
        return res ? res.clone() : undefined;
      },
      async put(req: Request, res: Response) {
        map.set(req.url, res.clone());
      },
    },
  };
  t.after(() => {
    (globalThis as { caches?: unknown }).caches = originalCaches;
  });

  const jobs: Promise<unknown>[] = [];
  const call = async (path: string, bodyPayload: unknown) => {
    const res = await worker.fetch(
      new Request(s.env.APP_ORIGIN + "/api/" + path, {
        method: "POST",
        headers: {
          Origin: s.env.APP_ORIGIN,
          Cookie: s.cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(bodyPayload),
      }),
      s.env,
      { waitUntil: (job: Promise<unknown>) => jobs.push(job) } as unknown as ExecutionContext,
    );
    await Promise.all(jobs.splice(0));
    return res;
  };

  const reportPayload = { ...plan, filters: { ...plan.filters, from: "2026-01", to: "2026-01" } };
  const firstReport = await call("report", reportPayload);
  assert.equal(firstReport.status, 200);
  assert.equal(firstReport.headers.get("X-Cache"), "MISS");
  assert.match(firstReport.headers.get("Server-Timing") ?? "", /^app;dur=\d+/);
  assert.match(firstReport.headers.get("Cache-Control") ?? "", /private, no-store/);

  const secondReport = await call("report", reportPayload);
  assert.equal(secondReport.status, 200);
  assert.equal(secondReport.headers.get("X-Cache"), "HIT");

  const firstOpts = await call("data/options", reportPayload.filters);
  assert.equal(firstOpts.status, 200);
  assert.equal(firstOpts.headers.get("X-Cache"), "MISS");
  const secondOpts = await call("data/options", reportPayload.filters);
  assert.equal(secondOpts.status, 200);
  assert.equal(secondOpts.headers.get("X-Cache"), "HIT");

  // Changing user scope_version must produce a MISS (different cache key), never stale ACL data
  s.sql.prepare("UPDATE users SET scope_version=scope_version+1 WHERE id='admin'").run();
  const afterScopeChange = await call("report", reportPayload);
  assert.equal(afterScopeChange.status, 200);
  assert.equal(afterScopeChange.headers.get("X-Cache"), "MISS");

  // Revoking session must return 401 and never serve from cache
  s.sql.prepare("DELETE FROM sessions WHERE user_id='admin'").run();
  const afterRevoke = await call("report", reportPayload);
  assert.equal(afterRevoke.status, 401);
});

test("MOBILE_ORIGINS enforces strict origin check by default and supports Capacitor Bearer auth when configured", async (t) => {
  const s = await setupWorkerWithNative();
  t.after(() => s.sql.close());

  const runFetch = (path: string, init: RequestInit) =>
    worker.fetch(new Request(s.env.APP_ORIGIN + "/api/" + path, init), s.env, {
      waitUntil() {},
    } as unknown as ExecutionContext);

  // Without MOBILE_ORIGINS, capacitor://localhost is blocked on POST
  const blocked = await runFetch("auth/login", {
    method: "POST",
    headers: {
      Origin: "capacitor://localhost",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email: "admin@example.test", password: s.pw }),
  });
  assert.equal(blocked.status, 403);

  // Enable MOBILE_ORIGINS
  s.env.MOBILE_ORIGINS = "capacitor://localhost,https://localhost";

  const preflight = await runFetch("report", {
    method: "OPTIONS",
    headers: { Origin: "capacitor://localhost" },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), "capacitor://localhost");

  const mobileLogin = await runFetch("auth/login", {
    method: "POST",
    headers: {
      Origin: "capacitor://localhost",
      "X-Client-Platform": "capacitor",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email: "admin@example.test", password: s.pw }),
  });
  assert.equal(mobileLogin.status, 200);
  assert.equal(mobileLogin.headers.get("Access-Control-Allow-Origin"), "capacitor://localhost");
  const loginJson = (await mobileLogin.json()) as { ok: boolean; token?: string };
  assert.equal(loginJson.ok, true);
  assert.match(loginJson.token ?? "", /^[a-f0-9]{64}$/);

  const meMobile = await runFetch("me", {
    method: "GET",
    headers: {
      Origin: "capacitor://localhost",
      Authorization: "Bearer " + loginJson.token,
    },
  });
  assert.equal(meMobile.status, 200);
  assert.equal(meMobile.headers.get("Access-Control-Allow-Origin"), "capacitor://localhost");

  const reportMobile = await runFetch("report", {
    method: "POST",
    headers: {
      Origin: "capacitor://localhost",
      "X-Client-Platform": "capacitor",
      Authorization: "Bearer " + loginJson.token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...plan, filters: { ...plan.filters, from: "2026-01", to: "2026-01" } }),
  });
  assert.equal(reportMobile.status, 200);

  const logoutMobile = await runFetch("auth/logout", {
    method: "POST",
    headers: {
      Origin: "capacitor://localhost",
      Authorization: "Bearer " + loginJson.token,
    },
  });
  assert.equal(logoutMobile.status, 200);

  const afterLogout = await runFetch("me", {
    method: "GET",
    headers: {
      Origin: "capacitor://localhost",
      Authorization: "Bearer " + loginJson.token,
    },
  });
  assert.equal(afterLogout.status, 401);
});
