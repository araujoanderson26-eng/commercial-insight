import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  deduplicateCustomers,
  parseCsvDate,
  parseCsvRecords,
  parseScaledCsvAmount,
} from "../shared/csv";
import worker from "../worker/index";
import { digest, now } from "../worker/core";
import { makeStore } from "./fixtures";
import { fakeR2 } from "./manual-fixtures";

function seedAuth(sql: ReturnType<typeof makeStore>["sql"], role: "admin" | "operador" | "comercial") {
  const id = randomUUID();
  const secret = createHash("sha256").update(id).digest("hex").slice(0, 64).padEnd(64, "a");
  sql
    .prepare("INSERT INTO users(id,email,name,password,role,national,active,created,update_only) VALUES(?,?,?,?,?,?,1,?,?)")
    .run(id, `${role}-${id.slice(0, 6)}@synthetic.test`, role.toUpperCase(), "hash", role === "operador" ? "comercial" : role, role === "admin" ? 1 : 0, now(), role === "operador" ? 1 : 0);
  sql
    .prepare("INSERT INTO sessions(hash,user_id,version,expires,seen) VALUES(?,?,1,?,?)")
    .run(createHash("sha256").update(secret).digest("hex"), id, now() + 3600, now());
  return { id, secret };
}

test("RFC-4180 CSV parser preserves embedded multiline fields, UTF-8 BOM and decimals", () => {
  const bomCsv =
    "\uFEFFSerial,Data do lanc.,Cód. PN,Valor mercadorias,ObservacaoComplementar\r\n" +
    '1001,2026-01-10,C01,"1234.56","Linha 1\nLinha 2 com ""aspas"" internas"\r\n' +
    '1002,15/01/2026,C02,"2.345,67","Observação simples"\r\n';
  const parsed = parseCsvRecords(bomCsv);
  assert.equal(parsed.headers.length, 5);
  assert.equal(parsed.headers[0], "Serial");
  assert.equal(parsed.rows.length, 2);
  assert.match(parsed.rows[0][4], /Linha 1\nLinha 2 com "aspas" internas/);
  assert.equal(parseCsvDate(parsed.rows[0][1]), "2026-01-10");
  assert.equal(parseCsvDate(parsed.rows[1][1]), "2026-01-15");
  assert.equal(parseScaledCsvAmount(parsed.rows[0][3], 4), 12345600);
  assert.equal(parseScaledCsvAmount(parsed.rows[1][3], 4), 23456700);
});

test("deduplicateCustomers collapses exact duplicates and surfaces attribute conflicts", () => {
  const clean = deduplicateCustomers([
    { client: "C01", name: "Cliente A", representative: "Rep 1", state: "SP", segment: "Varejo" },
    { client: "c01 ", name: "Cliente A", representative: "Rep 1", state: "SP", segment: "Varejo" },
    { client: "C02", name: "Cliente B", representative: "Rep 2", state: "RJ", segment: "Cash" },
  ]);
  assert.equal(clean.rows.length, 2);
  assert.equal(clean.duplicateCount, 1);
  assert.equal(clean.conflicts.length, 0);

  const conflicted = deduplicateCustomers([
    { client: "C01", name: "Nome 1", representative: "Rep 1", state: "SP" },
    { client: "C01", name: "Nome 2", representative: "Rep 1", state: "SP" },
  ]);
  assert.equal(conflicted.rows.length, 1);
  assert.ok(conflicted.conflicts.includes("C01:name"));
});

test("CSV batch pipeline supports staging, R2 processing, validation, diff, activation and rollback cleanly", async (t) => {
  const s = makeStore();
  t.after(() => s.sql.close());
  s.sql.exec(readFileSync(new URL("../migrations/0011_structured_csv_layer.sql", import.meta.url), "utf8"));
  s.env.BUCKET = fakeR2().bucket;
  const admin = seedAuth(s.sql, "admin");
  const operador = seedAuth(s.sql, "operador");
  const jobs: Promise<unknown>[] = [];

  const call = async (path: string, method: string, body: unknown, actorSecret: string, headers: Record<string, string> = {}) => {
    const isRaw = typeof body === "string";
    const res = await worker.fetch(
      new Request(s.env.APP_ORIGIN + "/api/" + path, {
        method,
        headers: {
          Origin: s.env.APP_ORIGIN,
          Cookie: "__Host-ci=" + actorSecret,
          ...(!isRaw && body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : isRaw ? body : JSON.stringify(body),
      }),
      s.env,
      { waitUntil: (p: Promise<unknown>) => jobs.push(p) } as unknown as ExecutionContext,
    );
    await Promise.all(jobs.splice(0));
    return res;
  };

  // Operador can stage/create batch & upload files, but cannot activate or rollback
  const batchRes = await call("admin/csv/batches", "POST", { sourceLabel: "Lote Sintético 1", referenceDate: "2026-01-31" }, operador.secret);
  assert.equal(batchRes.status, 201);
  const { id: batch1 } = (await batchRes.json()) as { id: string };

  const files: [string, string][] = [
    ["regions", "Unidade federativa,Sigla,Regional,Gerente,Região \nSão Paulo,SP,Sudeste,Gerente 1,Sudeste\n"],
    ["calendar", "Date,Dia,MÊS,Ano,Nome do Mes,Trimestre\n2026-01-10,10,1,2026,jan,1\n2026-01-11,11,1,2026,jan,1\n"],
    ["products", "Codigo Item,Descrição do item,Marca,Macro Categoria\nP1,Suco Uva,Marca X,SUCO\nP2,Vinho Tinto Granel,Marca Y,VINHO\n"],
    ["customers", 'Código Cliente,Cliente,Representantes,Estado,"Região ","Segmento "\nC1,Cliente SINTÉTICO 1,Rep A,SP,Sudeste,Varejo\nC1,Cliente SINTÉTICO 1,Rep A,SP,Sudeste,Varejo\n'],
    ["sales", "Serial,Data do lanc.,Codigo Cliente,Cliente,Canal,UF,Código do item,Grupo Item,Valor mercadorias\nNF-100,2026-01-10,C1,Cliente SINTÉTICO 1,Clientes Canal Direto,SP,P1,PA - SUCO,1000.00\nNF-101,2026-01-11,C1,Cliente SINTÉTICO 1,Clientes Canal Direto,SP,P2,PA - GRANEL,500.00\n"],
    ["returns", 'Nº Documento,Data do lanc.,Cód. PN,UF,Código do item,Grupo Item,Valor mercadorias,ObservacaoComplementar\nDEV-1,2026-01-11,C1,SP,P1,PA - SUCO,100.00,"Devolução\nem 2 linhas"\n'],
    ["orders", "Nº do documento,Código do cliente,UF,Data de lançamento,Valor em aberto,Valor original\nPED-99,C1,SP,2026-01-11,300.00,300.00\n"],
  ];

  for (const [role, csvText] of files) {
    const up = await call(`admin/csv/batches/${batch1}/files/${role}`, "PUT", csvText, operador.secret, {
      "Content-Type": "text/csv",
      "X-Filename": `${role}.csv`,
    });
    assert.equal(up.status, 200);
  }

  const proc = await call(`admin/csv/batches/${batch1}/process`, "POST", {}, operador.secret);
  assert.equal(proc.status, 200);
  const procJson = (await proc.json()) as { stats: Record<string, { rows: number; duplicates: number }> };
  assert.equal(procJson.stats.customers.rows, 1);
  assert.equal(procJson.stats.customers.duplicates, 1);
  assert.equal(procJson.stats.sales.rows, 2);
  assert.equal(procJson.stats.returns.rows, 1);

  const val = await call(`admin/csv/batches/${batch1}/validate`, "POST", {}, operador.secret);
  assert.equal(val.status, 200);
  const valJson = (await val.json()) as {
    passed: boolean;
    reconciliation: { grossRevenue: number; returns: number; netRevenue: number; distinctInvoices: number; ticketPerInvoice: number };
  };
  assert.equal(valJson.passed, true);
  assert.equal(valJson.reconciliation.grossRevenue, 1500);
  assert.equal(valJson.reconciliation.returns, 100);
  assert.equal(valJson.reconciliation.netRevenue, 1400);
  assert.equal(valJson.reconciliation.distinctInvoices, 2);
  assert.equal(valJson.reconciliation.ticketPerInvoice, 700);

  // Operador cannot activate or rollback
  assert.equal((await call(`admin/csv/batches/${batch1}/activate`, "POST", {}, operador.secret)).status, 403);
  assert.equal((await call("admin/csv/rollback", "POST", {}, operador.secret)).status, 403);

  // Admin activates batch1
  const act = await call(`admin/csv/batches/${batch1}/activate`, "POST", {}, admin.secret);
  assert.equal(act.status, 200);

  // Legacy ci_sources remains untouched!
  const legacySource = s.sql.prepare("SELECT source,active_version_id FROM ci_sources WHERE id='commercial-main'").get()!;
  assert.equal(legacySource.source, "powerbi");
  assert.equal(legacySource.active_version_id, null);

  // Second batch tracks diff against batch1 and rollback restores batch1
  const { id: batch2 } = (await (await call("admin/csv/batches", "POST", { sourceLabel: "Lote 2" }, admin.secret)).json()) as { id: string };
  for (const [role, csvText] of files) {
    const nextCsv =
      role === "customers"
        ? csvText + 'C2,Cliente SINTÉTICO 2,Rep A,SP,Sudeste,Varejo\n'
        : csvText;
    await call(`admin/csv/batches/${batch2}/files/${role}`, "PUT", nextCsv, admin.secret, { "Content-Type": "text/csv" });
  }
  const proc2 = (await (await call(`admin/csv/batches/${batch2}/process`, "POST", {}, admin.secret)).json()) as {
    diff: { added: { customers: number }; baselineBatchId: string };
  };
  assert.equal(proc2.diff.baselineBatchId, batch1);
  assert.equal(proc2.diff.added.customers, 1);

  await call(`admin/csv/batches/${batch2}/validate`, "POST", {}, admin.secret);
  await call(`admin/csv/batches/${batch2}/activate`, "POST", {}, admin.secret);

  const rb = await call("admin/csv/rollback", "POST", {}, admin.secret);
  assert.equal(rb.status, 200);
  const rbJson = (await rb.json()) as { activeBatchId: string; mode: string };
  assert.equal(rbJson.activeBatchId, batch1);
  assert.equal(rbJson.mode, "active");

  // Shadow reconciliation, options, report and deterministic ask routes (admin-only)
  assert.equal((await call(`admin/csv/batches/${batch1}/reconcile`, "GET", undefined, operador.secret)).status, 403);
  const recRes = await call(`admin/csv/batches/${batch1}/reconcile`, "GET", undefined, admin.secret);
  assert.equal(recRes.status, 200);
  const recJson = (await recRes.json()) as {
    ytd2026: { gross: number; returns: number; net: number };
    aggConsistency: { grossDeltaScaled: number; returnsDeltaScaled: number };
  };
  assert.equal(recJson.ytd2026.gross, 1500);
  assert.equal(recJson.ytd2026.returns, 100);
  assert.equal(recJson.ytd2026.net, 1400);
  assert.equal(recJson.aggConsistency.grossDeltaScaled, 0);
  assert.equal(recJson.aggConsistency.returnsDeltaScaled, 0);

  const optRes = await call(
    `admin/csv/batches/${batch1}/options`,
    "POST",
    { from: "2026-01", to: "2026-01", region: "", client: "", product: "" },
    admin.secret,
  );
  assert.equal(optRes.status, 200);
  const optJson = (await optRes.json()) as { values: { category: string[] } };
  assert.ok(optJson.values.category.includes("Macro Categoria: SUCO"));
  assert.ok(optJson.values.category.includes("PA - GRANEL"));

  const askRes = await call(
    `admin/csv/batches/${batch1}/ask`,
    "POST",
    {
      question: "Quanto faturamos em Suco e Vinho excluindo Granel em 2026?",
      filters: { from: "2026-01", to: "2026-01", region: "", client: "", product: "" },
    },
    admin.secret,
  );
  assert.equal(askRes.status, 200);
  const askJson = (await askRes.json()) as {
    meta: { engine: string; openaiCalls: number; mode: string };
    report: { total: { values: { gross: { current: number }; revenue: { current: number } } } };
  };
  assert.equal(askJson.meta.engine, "deterministic");
  assert.equal(askJson.meta.openaiCalls, 0);
  assert.equal(askJson.meta.mode, "shadow");
  // P1 SUCO = 1000 gross, 100 return, 900 net; P2 GRANEL (500) excluded!
  assert.equal(askJson.report.total.values.gross.current, 1000);
  assert.equal(askJson.report.total.values.revenue.current, 900);

  const repRes = await call(
    `admin/csv/batches/${batch1}/report`,
    "POST",
    {
      group: "category",
      metric: "revenue",
      order: "current",
      filters: { from: "2026-01", to: "2026-01", region: "", client: "", product: "" },
    },
    admin.secret,
  );
  assert.equal(repRes.status, 200);
  const repJson = (await repRes.json()) as { total: { values: { revenue: { current: number } } }; rows: { name: string }[] };
  assert.equal(repJson.total.values.revenue.current, 1400);
  assert.equal(repJson.rows.length, 2);

  assert.ok(await digest("ok"));
});
