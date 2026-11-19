import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { detectFilterConflicts, filtersSchema, type Plan } from "../shared/domain";
import { filterLabel } from "../src/export-model";
import type { DbUser } from "../worker/core";
import { nativePartStatements, queryNative } from "../worker/native-model";
import { makeStore, plan } from "./fixtures";
import { nativeFixture, type NativeRows } from "./native-fixtures";

const admin: DbUser = {
  id: "multi-admin",
  name: "Admin Teste",
  email: "multi@synthetic.test",
  role: "admin",
  password: "hash",
  regions: "[]",
  clients: "[]",
  national: 1,
  active: 1,
  entra_oid: null,
  scope_version: 1,
  version: 1,
};

async function setupMultiStore() {
  const s = makeStore();
  s.sql.exec(readFileSync(new URL("../migrations/0011_structured_csv_layer.sql", import.meta.url), "utf8"));
  const rows: NativeRows = {
    s: [
      ["2025-01-10", "0001", "P_SUCO", "PA - SUCO", "SP", "São Paulo", "100.00"],
      ["2026-01-10", "0001", "P_SUCO", "PA - SUCO", "SP", "São Paulo", "300.00"],
      ["2026-01-11", "0001", "P_VINHO", "PA - VINHO", "SP", "São Paulo", "200.00"],
      ["2026-01-12", "0001", "P_GRANEL", "PA - GRANEL", "SP", "São Paulo", "500.00"],
      ["2026-01-13", "0002", "P_ESP", "PA - ESPUMANTE", "RJ", "Rio de Janeiro", "150.00"],
      ["2026-01-14", "0003", "P_SUCO", "PA - SUCO", "SP", "São Paulo", "400.00"],
    ],
    r: [
      ["2026-01-10", "0001", "P_SUCO", "PA - SUCO", "SP", "20.00"],
      ["2026-01-12", "0001", "P_GRANEL", "PA - GRANEL", "SP", "50.00"],
    ],
    c: [
      ["0001", "Rep SP", "SP"],
      ["0002", "Rep RJ", "RJ"],
      ["0003", "Rep SP2", "SP"],
    ],
    d: [
      ["2025-01-10"],
      ["2026-01-10"],
      ["2026-01-11"],
      ["2026-01-12"],
      ["2026-01-13"],
      ["2026-01-14"],
    ],
    g: [
      ["SP", "Sudeste", "G1"],
      ["RJ", "Sudeste", "G1"],
      ["PR", "Sul", "G2"],
    ],
    m: [["São Paulo"], ["Rio de Janeiro"]],
    l: [["SP"], ["RJ"], ["PR"]],
    a: [["SP"], ["RJ"], ["PR"]],
    z: [],
  };

  const pkg = nativeFixture(rows, (manifest) => {
    manifest.projection.from = "2025-01-10";
    manifest.projection.to = "2026-01-14";
    manifest.controls = manifest.controls.slice(0, 6);
  });
  pkg.manifest.inventory.tables.push({
    ...pkg.manifest.inventory.tables[0],
    id: "products",
    name: "Base Produtos",
    columns: ["Codigo Item", "Macro Categoria"].map((name) => ({
      ...pkg.manifest.inventory.tables[0].columns[0],
      name,
    })),
    rowCount: 4,
    sourceRowCount: 4,
    parts: [],
  });
  for (const fact of [pkg.manifest.nativeModel!.sales, pkg.manifest.nativeModel!.returns]) {
    pkg.manifest.inventory.relationships.push({
      ...pkg.manifest.inventory.relationships[0],
      fromTable: fact.table,
      fromColumn: fact.product,
      toTable: "products",
      toColumn: "Codigo Item",
      isActive: true,
      crossFilteringBehavior: "OneDirection",
    });
  }

  const version = randomUUID();
  s.sql
    .prepare(
      "INSERT INTO ci_imports(id,owner,actor,filename,bytes,sha256,object_key,status,base_generation,created,updated,published,manifest) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(version, admin.id, admin.name, "multi.ci.ndjson", pkg.data.length, pkg.sha256, "local", "published", 0, 1, 1, 1, JSON.stringify(pkg.manifest));
  s.sql.prepare("UPDATE ci_sources SET source='manual',active_version_id=?,active_at=1 WHERE id='commercial-main'").run(version);
  for (const t of pkg.manifest.inventory.tables) {
    if (rows[t.id]) {
      await s.env.DB.batch(nativePartStatements(s.env, pkg.manifest, version, t.id, rows[t.id].map((values, i) => ({ row: i + 1, values }))));
    }
  }
  const macros: [string, string][] = [
    ["P_SUCO", "SUCO"],
    ["P_VINHO", "VINHO"],
    ["P_GRANEL", "VINHO GRANEL"],
    ["P_ESP", "ESPUMANTE"],
  ];
  for (const [i, pair] of macros.entries()) {
    s.sql.prepare("INSERT INTO ci_raw_rows(version_id,table_id,row_no,value) VALUES(?,?,?,?)").run(version, "products", i + 1, JSON.stringify(pair));
  }

  return { ...s, manifest: pkg.manifest, version };
}

test("Examples A, B and C multi-filters enforce Power BI inclusion/exclusion and dimensional intersection", async (t) => {
  const s = await setupMultiStore();
  t.after(() => s.sql.close());

  // Example A: SUCO + VINHO excluding GRANEL
  const exA = await queryNative(
    s.env,
    admin,
    {
      ...plan,
      filters: {
        from: "2026-01",
        to: "2026-01",
        region: "",
        client: "",
        product: "",
        categoriesInclude: ["Macro Categoria: SUCO", "Macro Categoria: VINHO"],
        categoriesExclude: ["PA - GRANEL"],
      },
    },
    s.manifest,
    s.version,
  );
  // Sales P_SUCO (300 + 400) + P_VINHO (200) = 900 gross (P_GRANEL excluded!)
  assert.equal(exA.total.values.gross.current, 900);

  // Example B: GRANEL only
  const exB = await queryNative(
    s.env,
    admin,
    {
      ...plan,
      filters: {
        from: "2026-01",
        to: "2026-01",
        region: "",
        client: "",
        product: "",
        categoriesInclude: ["PA - GRANEL"],
      },
    },
    s.manifest,
    s.version,
  );
  assert.equal(exB.total.values.gross.current, 500);
  assert.equal(exB.total.values.returns.current, 70);

  // Example C: SUCO + ESPUMANTE + SP + 2026 + multi-select reps ["Rep SP"]
  const exC = await queryNative(
    s.env,
    admin,
    {
      ...plan,
      filters: {
        from: "2026-01",
        to: "2026-01",
        region: "",
        client: "",
        product: "",
        states: ["SP"],
        regions: ["Rep SP"],
        categoriesInclude: ["Macro Categoria: SUCO", "Macro Categoria: ESPUMANTE"],
      },
    },
    s.manifest,
    s.version,
  );
  // Only 0001 / P_SUCO in SP under Rep SP = 300 gross (RJ P_ESP and Rep SP2 400 excluded!)
  assert.equal(exC.total.values.gross.current, 300);
});

test("multi-select arrays enforce ACL scope, range/direction filters and conflict alerts", async (t) => {
  const s = await setupMultiStore();
  t.after(() => s.sql.close());

  const limited: DbUser = {
    ...admin,
    id: "rep-limited",
    role: "comercial",
    national: 0,
    regions: '["Rep SP"]',
    clients: '["0001"]',
  };

  await assert.rejects(
    () =>
      queryNative(
        s.env,
        limited,
        {
          ...plan,
          filters: { from: "2026-01", to: "2026-01", region: "", client: "", product: "", regions: ["Rep SP", "Rep RJ"] },
        },
        s.manifest,
        s.version,
      ),
    /Seleção fora do seu escopo/,
  );

  // Range and growth direction filters on client ranking
  const growthOnly = await queryNative(
    s.env,
    admin,
    {
      group: "client",
      metric: "revenue",
      order: "growth",
      filters: {
        from: "2026-01",
        to: "2026-01",
        region: "",
        client: "",
        product: "",
        states: ["SP", "RJ"],
        variationDirection: "growth",
        revenueMin: 200,
      },
    },
    s.manifest,
    s.version,
  );
  assert.ok(growthOnly.rows.every((r) => (r.values.revenue.current ?? 0) >= 200));
  assert.ok(growthOnly.rows.every((r) => (r.values.revenue.current ?? 0) > (r.values.revenue.previous ?? 0)));

  // Conflict detection & Zod range checks
  const conflicts = detectFilterConflicts({
    from: "2026-01",
    to: "2026-01",
    region: "",
    client: "",
    product: "",
    categoriesInclude: ["PA - SUCO"],
    categoriesExclude: ["PA - SUCO"],
  });
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0], /exclusão prevalece/i);

  assert.equal(
    filtersSchema.safeParse({
      from: "2026-01",
      to: "2026-01",
      region: "",
      client: "",
      product: "",
      revenueMin: 500,
      revenueMax: 100,
    }).success,
    false,
  );

  // Export filterLabel reflects multi-select arrays & variation direction
  const label = filterLabel({
    ...growthOnly,
    plan: {
      ...(growthOnly.plan as Plan),
      filters: {
        ...growthOnly.plan.filters,
        states: ["SP", "RJ"],
        variationDirection: "growth",
      },
    },
  });
  assert.match(label, /UFs: SP, RJ/);
  assert.match(label, /Somente crescimento/);
});
