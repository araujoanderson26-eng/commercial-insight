/**
 * Loads all 20 Power BI CSVs into the ISOLATED Homologation D1 (`wrangler.hml.jsonc`)
 * strictly in shadow mode (`ci_csv_active.mode = 'shadow'`).
 * NEVER touches production (`wrangler.jsonc` / `5b333eba-7ace-4182-aa76-0d0f591a4ad6`).
 *
 * Usage:
 *   node --import tsx scripts/load-csv-hml-shadow.ts --dir "C:\path\to\Dax"
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parse } from "jsonc-parser";
import {
  cleanCsvDisplay,
  createCsvRecordParser,
  deduplicateCustomers,
  normalizeCsvKey,
  parseCsvDate,
  parseScaledCsvAmount,
  resolveCsvColumnMap,
  type CsvRole,
} from "../shared/csv";

const HML_DB_UUID = "9717c220-a4b4-4fad-8183-f2b733787b61";
const PROD_DB_UUID = "5b333eba-7ace-4182-aa76-0d0f591a4ad6";
const SCALE = 4;
const ROWS_PER_STMT = 25;
const ROWS_PER_CHUNK_FILE = 15000;

function parseArgs(argv: string[]) {
  let dir = process.env.CSV_DIR || "";
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir" && argv[i + 1]) dir = argv[++i];
    else if (argv[i] === "--dry-run") dryRun = true;
  }
  if (!dir) throw Error("Informe --dir com a pasta dos 20 CSVs.");
  return { dir: resolve(dir), dryRun };
}

function assertHmlConfigIsolation() {
  const hml = parse(readFileSync("wrangler.hml.jsonc", "utf8")) as {
    name?: string;
    d1_databases?: { database_name?: string; database_id?: string }[];
  };
  const prod = parse(readFileSync("wrangler.jsonc", "utf8")) as {
    d1_databases?: { database_id?: string }[];
  };
  const hmlDb = hml.d1_databases?.[0];
  if (
    hml.name !== "commercial-insight-hml" ||
    hmlDb?.database_name !== "commercial-insight-hml-db" ||
    hmlDb?.database_id !== HML_DB_UUID
  ) {
    throw Error("Configuração wrangler.hml.jsonc divergente do ambiente isolado de homologação.");
  }
  if (hmlDb.database_id === PROD_DB_UUID || prod.d1_databases?.some((d) => d.database_id === hmlDb.database_id)) {
    throw Error("BLOQUEADO: tentativa de usar D1 de produção detectada.");
  }
}

function wranglerBin(): string {
  const pkg = JSON.parse(readFileSync("node_modules/wrangler/package.json", "utf8")) as { bin: { wrangler: string } };
  return resolve("node_modules/wrangler", pkg.bin.wrangler);
}

function d1Command(sql: string) {
  const out = execFileSync(
    process.execPath,
    [wranglerBin(), "d1", "execute", "DB", "--remote", "--config", "wrangler.hml.jsonc", "--json", "--command", sql],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 },
  );
  return JSON.parse(out) as { results: Record<string, unknown>[] }[];
}

function d1File(filePath: string) {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      execFileSync(
        process.execPath,
        [wranglerBin(), "d1", "execute", "DB", "--remote", "--config", "wrangler.hml.jsonc", "--yes", "--file", filePath],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 },
      );
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < 3) {
        const waitMs = attempt * 2500;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
      }
    }
  }
  throw lastErr;
}

function sqlLit(val: unknown): string {
  if (val === null || val === undefined) return "NULL";
  if (typeof val === "number") return Number.isFinite(val) ? String(val) : "NULL";
  if (typeof val === "bigint") return String(val);
  const str = String(val).replaceAll("\0", "").replaceAll("'", "''");
  return `'${str}'`;
}

function buildMultiInserts(table: string, cols: string[], rows: unknown[][], verb = "INSERT OR REPLACE"): string {
  const lines: string[] = [];
  const prefix = `${verb} INTO ${table}(${cols.join(",")}) VALUES `;
  for (let i = 0; i < rows.length; i += ROWS_PER_STMT) {
    const slice = rows.slice(i, i + ROWS_PER_STMT);
    const tuples = slice.map((r) => `(${r.map(sqlLit).join(",")})`).join(",");
    lines.push(`${prefix}${tuples};`);
  }
  return lines.join("\n");
}

function slugRole(filename: string): string {
  const folded = filename
    .replace(/\.csv$/i, "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `auxiliary:${folded}`;
}

function classifyCsvFile(filename: string): { kind: "core"; role: CsvRole } | { kind: "auxiliary"; role: string } {
  const folded = filename
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
  if (folded === "base regionais.csv") return { kind: "core", role: "regions" };
  if (folded === "dcalendario.csv") return { kind: "core", role: "calendar" };
  if (folded === "base produtos.csv") return { kind: "core", role: "products" };
  if (folded === "base clientes.csv") return { kind: "core", role: "customers" };
  if (folded === "faturamento.csv") return { kind: "core", role: "sales" };
  if (folded === "devolucao.csv") return { kind: "core", role: "returns" };
  if (folded === "base pedidos.csv") return { kind: "core", role: "orders" };
  if (folded === "estoque.csv") return { kind: "auxiliary", role: "stock" };
  if (folded === "base metas.csv") return { kind: "auxiliary", role: "targets" };
  if (folded === "orcamento.csv") return { kind: "auxiliary", role: "budget" };
  if (folded === "rep area.csv") return { kind: "auxiliary", role: "rep_area" };
  return { kind: "auxiliary", role: slugRole(filename) };
}

async function streamFileCsv(
  filePath: string,
  onRecord: (record: string[], rowIndex: number) => void,
): Promise<{ bytes: number; sha256: string; totalRecords: number }> {
  const hash = createHash("sha256");
  const parser = createCsvRecordParser();
  const decoder = new TextDecoder("utf-8");
  let rowIndex = 0;
  const bytes = statSync(filePath).size;
  if (bytes === 0) {
    return { bytes: 0, sha256: hash.digest("hex"), totalRecords: 0 };
  }

  await new Promise<void>((res, rej) => {
    const stream = createReadStream(filePath, { highWaterMark: 128 * 1024 });
    stream.on("data", (chunk) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      hash.update(buf);
      const text = decoder.decode(buf, { stream: true });
      if (!text) return;
      for (const rec of parser.push(text)) {
        onRecord(rec, rowIndex++);
      }
    });
    stream.on("end", () => {
      const tail = decoder.decode();
      if (tail) {
        for (const rec of parser.push(tail)) {
          onRecord(rec, rowIndex++);
        }
      }
      for (const rec of parser.finish()) {
        onRecord(rec, rowIndex++);
      }
      res();
    });
    stream.on("error", rej);
  });

  return { bytes, sha256: hash.digest("hex"), totalRecords: rowIndex };
}

async function main() {
  const { dir, dryRun } = parseArgs(process.argv.slice(2));
  assertHmlConfigIsolation();

  if (!dryRun) {
    const active = d1Command("SELECT active_batch_id, mode FROM ci_csv_active WHERE id=1")[0]?.results?.[0];
    if (!active || active.mode !== "shadow" || active.active_batch_id !== null) {
      throw Error(`HML ci_csv_active inesperado antes da carga: ${JSON.stringify(active)}. Esperado mode='shadow'.`);
    }
  }

  const allCsvNames = readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".csv"))
    .sort((a, b) => a.localeCompare(b, "pt-BR"));
  if (allCsvNames.length !== 20) {
    throw Error(`Esperados 20 arquivos CSV em ${dir}; encontrados ${allCsvNames.length}.`);
  }

  const workDir = resolve(".wrangler/hml");
  const chunkDir = join(workDir, "sql-chunks");
  const stagingPath = join(workDir, "staging-shadow.sqlite");
  mkdirSync(workDir, { recursive: true });
  rmSync(chunkDir, { recursive: true, force: true });
  rmSync(stagingPath, { force: true });
  mkdirSync(chunkDir, { recursive: true });

  const db = new DatabaseSync(stagingPath);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-128000; PRAGMA foreign_keys=ON;");
  db.exec(readFileSync("migrations/0011_structured_csv_layer.sql", "utf8"));

  const batchId = randomUUID();
  const ts = Math.floor(Date.now() / 1000);
  const t0 = Date.now();

  db.prepare(
    "INSERT INTO ci_csv_batches(id,actor,owner,status,source_label,created,updated) VALUES(?,?,?,?,?,?,?)",
  ).run(batchId, "hml-shadow-loader", "hml-shadow-loader", "processing", "Homologação HML Shadow (20 CSVs)", ts, ts);

  const upsertFile = db.prepare(
    `INSERT OR REPLACE INTO ci_csv_files(batch_id,role,filename,sha256,bytes,object_key,row_count,duplicate_count,rejected_count,status,schema_json,updated)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
  );

  const coreByRole = new Map<CsvRole, string>();
  const auxFiles: { filename: string; role: string; filePath: string }[] = [];
  for (const name of allCsvNames) {
    const cls = classifyCsvFile(name);
    const full = join(dir, name);
    if (cls.kind === "core") coreByRole.set(cls.role, full);
    else auxFiles.push({ filename: name, role: cls.role, filePath: full });
  }
  for (const reqRole of ["regions", "calendar", "products", "customers", "sales", "returns", "orders"] as CsvRole[]) {
    if (!coreByRole.has(reqRole)) throw Error(`CSV obrigatório ausente: ${reqRole}`);
  }

  const productMacro = new Map<string, string>();
  let minDate: string | null = null;
  let maxDate: string | null = null;

  // 1. Regions
  {
    const filePath = coreByRole.get("regions")!;
    let headers: string[] = [];
    let map: Record<string, number> = {};
    let rows = 0;
    let rejected = 0;
    const ins = db.prepare(
      "INSERT OR REPLACE INTO ci_dim_regions(batch_id,state_key,state_name,regional_key,regional_raw,manager_key,manager_raw,region_name) VALUES(?,?,?,?,?,?,?,?)",
    );
    db.exec("BEGIN");
    const meta = await streamFileCsv(filePath, (rec, idx) => {
      if (idx === 0) {
        headers = rec.map((h) => h.trim());
        map = resolveCsvColumnMap("regions", headers).map;
        return;
      }
      const stateKey = normalizeCsvKey(rec[map.state]);
      if (!stateKey) {
        rejected++;
        return;
      }
      ins.run(
        batchId,
        stateKey,
        cleanCsvDisplay(map.stateName !== undefined ? rec[map.stateName] : null),
        normalizeCsvKey(rec[map.regional]),
        cleanCsvDisplay(rec[map.regional]),
        normalizeCsvKey(map.manager !== undefined ? rec[map.manager] : null),
        cleanCsvDisplay(map.manager !== undefined ? rec[map.manager] : null),
        cleanCsvDisplay(map.regionName !== undefined ? rec[map.regionName] : null),
      );
      rows++;
    });
    db.exec("COMMIT");
    upsertFile.run(batchId, "regions", "Base Regionais.csv", meta.sha256, meta.bytes, null, rows, 0, rejected, "processed", JSON.stringify(headers), ts);
  }

  // 2. Calendar
  {
    const filePath = coreByRole.get("calendar")!;
    let headers: string[] = [];
    let map: Record<string, number> = {};
    let rows = 0;
    let rejected = 0;
    const ins = db.prepare(
      "INSERT OR IGNORE INTO ci_dim_calendar(batch_id,date,year,month,month_key,quarter) VALUES(?,?,?,?,?,?)",
    );
    db.exec("BEGIN");
    const meta = await streamFileCsv(filePath, (rec, idx) => {
      if (idx === 0) {
        headers = rec.map((h) => h.trim());
        map = resolveCsvColumnMap("calendar", headers).map;
        return;
      }
      const date = parseCsvDate(rec[map.date]);
      if (!date) {
        rejected++;
        return;
      }
      const y = Number(date.slice(0, 4));
      const m = Number(date.slice(5, 7));
      ins.run(batchId, date, y, m, date.slice(0, 7), Math.ceil(m / 3));
      rows++;
    });
    db.exec("COMMIT");
    upsertFile.run(batchId, "calendar", "dCalendario.csv", meta.sha256, meta.bytes, null, rows, 0, rejected, "processed", JSON.stringify(headers), ts);
  }

  // 3. Products
  let productRowsCount = 0;
  {
    const filePath = coreByRole.get("products")!;
    let headers: string[] = [];
    let map: Record<string, number> = {};
    let rejected = 0;
    const ins = db.prepare(
      "INSERT OR REPLACE INTO ci_dim_products(batch_id,product_key,product_raw,description,brand,macro_category_key,macro_category_raw,unit_liters,box_liters,pack_qty,unit_measure,abc_class) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    db.exec("BEGIN");
    const meta = await streamFileCsv(filePath, (rec, idx) => {
      if (idx === 0) {
        headers = rec.map((h) => h.trim());
        map = resolveCsvColumnMap("products", headers).map;
        return;
      }
      const productKey = normalizeCsvKey(rec[map.product]);
      const productRaw = cleanCsvDisplay(rec[map.product]);
      if (!productKey || !productRaw) {
        rejected++;
        return;
      }
      const macroKey = normalizeCsvKey(rec[map.macroCategory]);
      const macroRaw = cleanCsvDisplay(rec[map.macroCategory]);
      if (macroKey) productMacro.set(productKey, macroKey);
      ins.run(
        batchId,
        productKey,
        productRaw,
        cleanCsvDisplay(map.description !== undefined ? rec[map.description] : null),
        cleanCsvDisplay(map.brand !== undefined ? rec[map.brand] : null),
        macroKey,
        macroRaw,
        map.unitLiters !== undefined ? parseScaledCsvAmount(rec[map.unitLiters], SCALE, true) : null,
        map.boxLiters !== undefined ? parseScaledCsvAmount(rec[map.boxLiters], SCALE, true) : null,
        map.packQty !== undefined ? parseScaledCsvAmount(rec[map.packQty], SCALE, true) : null,
        cleanCsvDisplay(map.unitMeasure !== undefined ? rec[map.unitMeasure] : null),
        cleanCsvDisplay(map.abcClass !== undefined ? rec[map.abcClass] : null),
      );
      productRowsCount++;
    });
    db.exec("COMMIT");
    upsertFile.run(batchId, "products", "Base Produtos.csv", meta.sha256, meta.bytes, null, productRowsCount, 0, rejected, "processed", JSON.stringify(headers), ts);
  }

  // 4. Customers
  let customerRowsCount = 0;
  let customerDuplicates = 0;
  let customerConflicts: string[] = [];
  {
    const filePath = coreByRole.get("customers")!;
    let headers: string[] = [];
    let map: Record<string, number> = {};
    const raw: Parameters<typeof deduplicateCustomers>[0] = [];
    const meta = await streamFileCsv(filePath, (rec, idx) => {
      if (idx === 0) {
        headers = rec.map((h) => h.trim());
        map = resolveCsvColumnMap("customers", headers).map;
        return;
      }
      raw.push({
        client: rec[map.client],
        name: map.name !== undefined ? rec[map.name] : null,
        representative: map.representative !== undefined ? rec[map.representative] : null,
        state: map.state !== undefined ? rec[map.state] : null,
        regional: map.regional !== undefined ? rec[map.regional] : null,
        segment: map.segment !== undefined ? rec[map.segment] : null,
        saleType: map.saleType !== undefined ? rec[map.saleType] : null,
      });
    });
    const dedup = deduplicateCustomers(raw);
    customerRowsCount = dedup.rows.length;
    customerDuplicates = dedup.duplicateCount;
    customerConflicts = dedup.conflicts;
    const ins = db.prepare(
      "INSERT OR REPLACE INTO ci_dim_customers(batch_id,client_key,client_raw,name,representative_key,representative_raw,state_key,regional_raw,segment,sale_type,source_rows) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    );
    db.exec("BEGIN");
    for (const r of dedup.rows) {
      ins.run(batchId, r.clientKey, r.clientRaw, r.name, r.representativeKey, r.representativeRaw, r.stateKey, r.regionalRaw, r.segment, r.saleType, r.sourceRows);
    }
    db.exec("COMMIT");
    upsertFile.run(batchId, "customers", "Base Clientes.csv", meta.sha256, meta.bytes, null, customerRowsCount, customerDuplicates, dedup.rejectedCount, "processed", JSON.stringify(headers), ts);
  }

  // 5. Sales
  console.log(JSON.stringify({ stage: "loading_sales_csv", batchId, elapsedMs: Date.now() - t0 }));
  let salesRowsCount = 0;
  {
    const filePath = coreByRole.get("sales")!;
    let headers: string[] = [];
    let map: Record<string, number> = {};
    let rejected = 0;
    const ins = db.prepare(
      "INSERT INTO ci_fact_sales(batch_id,row_no,date,month_key,doc_no,client_key,client_raw,product_key,product_raw,group_key,group_raw,macro_key,state_key,municipality,channel,regional_raw,utilization,qty,liters,gross_amount,accounting_amount) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    db.exec("BEGIN");
    const meta = await streamFileCsv(filePath, (rec, idx) => {
      if (idx === 0) {
        headers = rec.map((h) => h.trim());
        map = resolveCsvColumnMap("sales", headers).map;
        return;
      }
      const date = parseCsvDate(rec[map.date]);
      const gross = parseScaledCsvAmount(rec[map.amount], SCALE);
      if (!date || gross === null) {
        rejected++;
        return;
      }
      if (!minDate || date < minDate) minDate = date;
      if (!maxDate || date > maxDate) maxDate = date;
      salesRowsCount++;
      const productKey = normalizeCsvKey(rec[map.product]);
      const macroKey = productKey ? productMacro.get(productKey) ?? null : null;
      ins.run(
        batchId,
        salesRowsCount,
        date,
        date.slice(0, 7),
        cleanCsvDisplay(map.docNo !== undefined ? rec[map.docNo] : null),
        normalizeCsvKey(rec[map.client]),
        cleanCsvDisplay(rec[map.client]),
        productKey,
        cleanCsvDisplay(rec[map.product]),
        normalizeCsvKey(map.group !== undefined ? rec[map.group] : null),
        cleanCsvDisplay(map.group !== undefined ? rec[map.group] : null),
        macroKey,
        normalizeCsvKey(map.state !== undefined ? rec[map.state] : null),
        cleanCsvDisplay(map.municipality !== undefined ? rec[map.municipality] : null),
        cleanCsvDisplay(map.channel !== undefined ? rec[map.channel] : null),
        cleanCsvDisplay(map.regional !== undefined ? rec[map.regional] : null),
        cleanCsvDisplay(map.utilization !== undefined ? rec[map.utilization] : null),
        map.qty !== undefined ? parseScaledCsvAmount(rec[map.qty], SCALE, true) : null,
        map.liters !== undefined ? parseScaledCsvAmount(rec[map.liters], SCALE, true) : null,
        gross,
        map.accountingAmount !== undefined ? parseScaledCsvAmount(rec[map.accountingAmount], SCALE) : null,
      );
    });
    db.exec("COMMIT");
    upsertFile.run(batchId, "sales", "Faturamento.csv", meta.sha256, meta.bytes, null, salesRowsCount, 0, rejected, "processed", JSON.stringify(headers), ts);
  }

  // 6. Returns
  console.log(JSON.stringify({ stage: "sales_loaded", salesRowsCount, elapsedMs: Date.now() - t0 }));
  let returnRowsCount = 0;
  {
    const filePath = coreByRole.get("returns")!;
    let headers: string[] = [];
    let map: Record<string, number> = {};
    let rejected = 0;
    const ins = db.prepare(
      "INSERT INTO ci_fact_returns(batch_id,row_no,date,month_key,doc_no,client_key,client_raw,product_key,product_raw,group_key,group_raw,macro_key,state_key,qty,liters,return_amount) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    db.exec("BEGIN");
    const meta = await streamFileCsv(filePath, (rec, idx) => {
      if (idx === 0) {
        headers = rec.map((h) => h.trim());
        map = resolveCsvColumnMap("returns", headers).map;
        return;
      }
      const date = parseCsvDate(rec[map.date]);
      const ret = parseScaledCsvAmount(rec[map.amount], SCALE);
      if (!date || ret === null) {
        rejected++;
        return;
      }
      if (!minDate || date < minDate) minDate = date;
      if (!maxDate || date > maxDate) maxDate = date;
      returnRowsCount++;
      const productKey = map.product !== undefined ? normalizeCsvKey(rec[map.product]) : null;
      const macroKey = productKey ? productMacro.get(productKey) ?? null : null;
      ins.run(
        batchId,
        returnRowsCount,
        date,
        date.slice(0, 7),
        cleanCsvDisplay(map.docNo !== undefined ? rec[map.docNo] : null),
        normalizeCsvKey(rec[map.client]),
        cleanCsvDisplay(rec[map.client]),
        productKey,
        cleanCsvDisplay(map.product !== undefined ? rec[map.product] : null),
        normalizeCsvKey(map.group !== undefined ? rec[map.group] : null),
        cleanCsvDisplay(map.group !== undefined ? rec[map.group] : null),
        macroKey,
        normalizeCsvKey(map.state !== undefined ? rec[map.state] : null),
        map.qty !== undefined ? parseScaledCsvAmount(rec[map.qty], SCALE, true) : null,
        map.liters !== undefined ? parseScaledCsvAmount(rec[map.liters], SCALE, true) : null,
        ret,
      );
    });
    db.exec("COMMIT");
    upsertFile.run(batchId, "returns", "DEVOLUÇÃO.csv", meta.sha256, meta.bytes, null, returnRowsCount, 0, rejected, "processed", JSON.stringify(headers), ts);
  }

  // 7. Orders (backlog isolated)
  let ordersRowsCount = 0;
  {
    const filePath = coreByRole.get("orders")!;
    let headers: string[] = [];
    let map: Record<string, number> = {};
    const ins = db.prepare(
      "INSERT INTO ci_fact_orders_open(batch_id,row_no,doc_no,doc_date,client_key,client_raw,state_key,status,utilization,open_amount,original_amount) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    );
    db.exec("BEGIN");
    const meta = await streamFileCsv(filePath, (rec, idx) => {
      if (idx === 0) {
        headers = rec.map((h) => h.trim());
        map = resolveCsvColumnMap("orders", headers).map;
        return;
      }
      const docNo = cleanCsvDisplay(rec[map.docNo]);
      if (!docNo) return;
      ordersRowsCount++;
      ins.run(
        batchId,
        ordersRowsCount,
        docNo,
        map.date !== undefined ? parseCsvDate(rec[map.date]) : null,
        map.client !== undefined ? normalizeCsvKey(rec[map.client]) : null,
        map.client !== undefined ? cleanCsvDisplay(rec[map.client]) : null,
        map.state !== undefined ? normalizeCsvKey(rec[map.state]) : null,
        "aberto",
        map.utilization !== undefined ? cleanCsvDisplay(rec[map.utilization]) : null,
        map.openAmount !== undefined ? parseScaledCsvAmount(rec[map.openAmount], SCALE) : null,
        map.originalAmount !== undefined ? parseScaledCsvAmount(rec[map.originalAmount], SCALE) : null,
      );
    });
    db.exec("COMMIT");
    upsertFile.run(batchId, "orders", "Base Pedidos.csv", meta.sha256, meta.bytes, null, ordersRowsCount, 0, 0, "processed", JSON.stringify(headers), ts);
  }

  // 8. Validate & inventory remaining 13 auxiliary CSVs so all 20 CSVs are tracked in ci_csv_files
  for (const aux of auxFiles) {
    let headers: string[] = [];
    const meta = await streamFileCsv(aux.filePath, (rec, idx) => {
      if (idx === 0) headers = rec.map((h) => h.trim());
    });
    const dataRows = Math.max(0, meta.totalRecords - (headers.length ? 1 : 0));
    upsertFile.run(batchId, aux.role, aux.filename, meta.sha256, meta.bytes, null, dataRows, 0, 0, "validated_auxiliary", JSON.stringify(headers), ts);
  }

  // 9. Build ci_agg_monthly and ci_dim_catalog locally
  db.exec("BEGIN");
  db.prepare(
    `INSERT INTO ci_agg_monthly(
      batch_id,month_key,state_key,regional_key,manager_key,representative_key,
      macro_key,group_key,channel,segment,brand,gross_amount,return_amount,net_amount,sales_rows,return_rows
    )
    SELECT ?,month_key,state_key,regional_key,manager_key,representative_key,
      macro_key,group_key,channel,segment,brand,
      SUM(gross_amount),SUM(return_amount),SUM(gross_amount)-SUM(return_amount),SUM(sales_rows),SUM(return_rows)
    FROM (
      SELECT s.month_key,COALESCE(s.state_key,'') AS state_key,COALESCE(rg.regional_key,'') AS regional_key,
        COALESCE(rg.manager_key,'') AS manager_key,COALESCE(c.representative_key,'') AS representative_key,
        COALESCE(p.macro_category_key,s.macro_key,'') AS macro_key,COALESCE(s.group_key,'') AS group_key,
        COALESCE(s.channel,'') AS channel,COALESCE(c.segment,'') AS segment,COALESCE(p.brand,'') AS brand,
        s.gross_amount,0 AS return_amount,1 AS sales_rows,0 AS return_rows
      FROM ci_fact_sales s
      LEFT JOIN ci_dim_customers c ON c.batch_id=s.batch_id AND c.client_key=s.client_key
      LEFT JOIN ci_dim_products p ON p.batch_id=s.batch_id AND p.product_key=s.product_key
      LEFT JOIN ci_dim_regions rg ON rg.batch_id=s.batch_id AND rg.state_key=s.state_key
      WHERE s.batch_id=?
      UNION ALL
      SELECT r.month_key,COALESCE(r.state_key,'') AS state_key,COALESCE(rg.regional_key,'') AS regional_key,
        COALESCE(rg.manager_key,'') AS manager_key,COALESCE(c.representative_key,'') AS representative_key,
        COALESCE(p.macro_category_key,r.macro_key,'') AS macro_key,COALESCE(r.group_key,'') AS group_key,
        '' AS channel,COALESCE(c.segment,'') AS segment,COALESCE(p.brand,'') AS brand,
        0 AS gross_amount,r.return_amount,0 AS sales_rows,1 AS return_rows
      FROM ci_fact_returns r
      LEFT JOIN ci_dim_customers c ON c.batch_id=r.batch_id AND c.client_key=r.client_key
      LEFT JOIN ci_dim_products p ON p.batch_id=r.batch_id AND p.product_key=r.product_key
      LEFT JOIN ci_dim_regions rg ON rg.batch_id=r.batch_id AND rg.state_key=r.state_key
      WHERE r.batch_id=?
    ) GROUP BY month_key,state_key,regional_key,manager_key,representative_key,macro_key,group_key,channel,segment,brand`,
  ).run(batchId, batchId, batchId);

  const catalogQueries: [string, unknown[]][] = [
    ["INSERT OR IGNORE INTO ci_dim_catalog(batch_id,dimension,value_key,display,extra) SELECT ?, 'state', state_key, COALESCE(state_name,state_key), regional_raw FROM ci_dim_regions WHERE batch_id=?", [batchId, batchId]],
    ["INSERT OR IGNORE INTO ci_dim_catalog(batch_id,dimension,value_key,display,extra) SELECT DISTINCT ?, 'regional', regional_key, COALESCE(regional_raw,regional_key), manager_raw FROM ci_dim_regions WHERE batch_id=? AND regional_key IS NOT NULL", [batchId, batchId]],
    ["INSERT OR IGNORE INTO ci_dim_catalog(batch_id,dimension,value_key,display,extra) SELECT DISTINCT ?, 'manager', manager_key, COALESCE(manager_raw,manager_key), NULL FROM ci_dim_regions WHERE batch_id=? AND manager_key IS NOT NULL", [batchId, batchId]],
    ["INSERT OR IGNORE INTO ci_dim_catalog(batch_id,dimension,value_key,display,extra) SELECT DISTINCT ?, 'representative', representative_key, COALESCE(representative_raw,representative_key), NULL FROM ci_dim_customers WHERE batch_id=? AND representative_key IS NOT NULL", [batchId, batchId]],
    ["INSERT OR IGNORE INTO ci_dim_catalog(batch_id,dimension,value_key,display,extra) SELECT DISTINCT ?, 'macro_category', macro_category_key, COALESCE(macro_category_raw,macro_category_key), NULL FROM ci_dim_products WHERE batch_id=? AND macro_category_key IS NOT NULL", [batchId, batchId]],
    ["INSERT OR IGNORE INTO ci_dim_catalog(batch_id,dimension,value_key,display,extra) SELECT DISTINCT ?, 'group', group_key, COALESCE(group_raw,group_key), MAX(macro_key) FROM ci_fact_sales WHERE batch_id=? AND group_key IS NOT NULL GROUP BY group_key", [batchId, batchId]],
    ["INSERT OR IGNORE INTO ci_dim_catalog(batch_id,dimension,value_key,display,extra) SELECT DISTINCT ?, 'channel', channel, channel, NULL FROM ci_fact_sales WHERE batch_id=? AND channel IS NOT NULL", [batchId, batchId]],
    ["INSERT OR IGNORE INTO ci_dim_catalog(batch_id,dimension,value_key,display,extra) SELECT DISTINCT ?, 'segment', segment, segment, NULL FROM ci_dim_customers WHERE batch_id=? AND segment IS NOT NULL", [batchId, batchId]],
    ["INSERT OR IGNORE INTO ci_dim_catalog(batch_id,dimension,value_key,display,extra) SELECT DISTINCT ?, 'brand', brand, brand, NULL FROM ci_dim_products WHERE batch_id=? AND brand IS NOT NULL", [batchId, batchId]],
  ];
  for (const [q, a] of catalogQueries) db.prepare(q).run(...(a as string[]));

  const summaryJson = JSON.stringify({
    customerDuplicates,
    customerConflicts,
    fileCount: allCsvNames.length,
    ordersOpen: ordersRowsCount,
  });
  const diffJson = JSON.stringify({ baselineBatchId: null, initialLoad: true, added: {}, removed: {} });
  db.prepare(
    "UPDATE ci_csv_batches SET status='processing',reference_date=?,coverage_from=?,coverage_to=?,file_count=?,sales_rows=?,return_rows=?,customer_rows=?,product_rows=?,summary_json=?,diff_json=?,updated=? WHERE id=?",
  ).run(maxDate, minDate, maxDate, allCsvNames.length, salesRowsCount, returnRowsCount, customerRowsCount, productRowsCount, summaryJson, diffJson, ts, batchId);
  db.exec("COMMIT");

  // Local sanity checks before touching remote HML D1
  const localCheck = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM ci_csv_files WHERE batch_id=?) AS files_n,
       (SELECT COUNT(*) FROM ci_dim_catalog WHERE batch_id=? AND dimension='macro_category') AS macros_n,
       (SELECT COUNT(*) FROM ci_dim_catalog WHERE batch_id=? AND dimension='group') AS groups_n,
       (SELECT SUM(gross_amount) FROM ci_fact_sales WHERE batch_id=?) - (SELECT SUM(gross_amount) FROM ci_agg_monthly WHERE batch_id=?) AS gross_delta,
       (SELECT SUM(return_amount) FROM ci_fact_returns WHERE batch_id=?) - (SELECT SUM(return_amount) FROM ci_agg_monthly WHERE batch_id=?) AS ret_delta`,
  ).get(batchId, batchId, batchId, batchId, batchId, batchId, batchId) as Record<string, number>;
  if (localCheck.files_n !== 20 || localCheck.gross_delta !== 0 || localCheck.ret_delta !== 0) {
    throw Error(`Falha na conferência local pré-upload: ${JSON.stringify(localCheck)}`);
  }

  // 10. Export transaction-free SQL chunks in FK-safe order
  const chunkFiles: { name: string; path: string; rows: number }[] = [];
  let chunkSeq = 0;
  const writeChunk = (label: string, sqlBody: string, rowCount: number) => {
    if (!sqlBody.trim()) return;
    const name = `${String(chunkSeq++).padStart(3, "0")}-${label}.sql`;
    const filePath = join(chunkDir, name);
    writeFileSync(filePath, sqlBody + "\n", "utf8");
    chunkFiles.push({ name, path: filePath, rows: rowCount });
  };

  const fetchRows = (table: string, cols: string[], orderBy?: string) =>
    db
      .prepare(`SELECT ${cols.join(",")} FROM ${table} WHERE batch_id=?${orderBy ? ` ORDER BY ${orderBy}` : ""}`)
      .all(batchId)
      .map((r) => cols.map((c) => (r as Record<string, unknown>)[c]));

  const batchCols = ["id", "actor", "owner", "status", "source_label", "reference_date", "coverage_from", "coverage_to", "file_count", "sales_rows", "return_rows", "customer_rows", "product_rows", "summary_json", "diff_json", "created", "updated"];
  const batchRow = db.prepare(`SELECT ${batchCols.join(",")} FROM ci_csv_batches WHERE id=?`).get(batchId) as Record<string, unknown>;
  const fileCols = ["batch_id", "role", "filename", "sha256", "bytes", "object_key", "row_count", "duplicate_count", "rejected_count", "status", "schema_json", "updated"];
  const regCols = ["batch_id", "state_key", "state_name", "regional_key", "regional_raw", "manager_key", "manager_raw", "region_name"];
  const calCols = ["batch_id", "date", "year", "month", "month_key", "quarter"];
  const prodCols = ["batch_id", "product_key", "product_raw", "description", "brand", "macro_category_key", "macro_category_raw", "unit_liters", "box_liters", "pack_qty", "unit_measure", "abc_class"];
  const ordCols = ["batch_id", "row_no", "doc_no", "doc_date", "client_key", "client_raw", "state_key", "status", "utilization", "open_amount", "original_amount"];
  const custCols = ["batch_id", "client_key", "client_raw", "name", "representative_key", "representative_raw", "state_key", "regional_raw", "segment", "sale_type", "source_rows"];
  const salesCols = ["batch_id", "row_no", "date", "month_key", "doc_no", "client_key", "client_raw", "product_key", "product_raw", "group_key", "group_raw", "macro_key", "state_key", "municipality", "channel", "regional_raw", "utilization", "qty", "liters", "gross_amount", "accounting_amount"];
  const retCols = ["batch_id", "row_no", "date", "month_key", "doc_no", "client_key", "client_raw", "product_key", "product_raw", "group_key", "group_raw", "macro_key", "state_key", "qty", "liters", "return_amount"];
  const aggCols = ["batch_id", "month_key", "state_key", "regional_key", "manager_key", "representative_key", "macro_key", "group_key", "channel", "segment", "brand", "gross_amount", "return_amount", "net_amount", "sales_rows", "return_rows"];
  const catCols = ["batch_id", "dimension", "value_key", "display", "extra"];

  const metaSql = [
    buildMultiInserts("ci_csv_batches", batchCols, [batchCols.map((c) => batchRow[c])]),
    buildMultiInserts("ci_csv_files", fileCols, fetchRows("ci_csv_files", fileCols)),
    buildMultiInserts("ci_dim_regions", regCols, fetchRows("ci_dim_regions", regCols)),
    buildMultiInserts("ci_dim_calendar", calCols, fetchRows("ci_dim_calendar", calCols, "date")),
    buildMultiInserts("ci_dim_products", prodCols, fetchRows("ci_dim_products", prodCols, "product_key")),
    buildMultiInserts("ci_fact_orders_open", ordCols, fetchRows("ci_fact_orders_open", ordCols, "row_no")),
  ].join("\n");
  writeChunk("meta-dims", metaSql, 1 + 20 + productRowsCount + ordersRowsCount);

  const exportTableChunked = (label: string, table: string, cols: string[], orderBy?: string) => {
    const stmtAll = db.prepare(
      `SELECT ${cols.join(",")} FROM ${table} WHERE batch_id=?${orderBy ? ` ORDER BY ${orderBy}` : ""}`,
    );
    let buf: unknown[][] = [];
    let part = 1;
    for (const row of stmtAll.iterate(batchId)) {
      buf.push(cols.map((c) => (row as Record<string, unknown>)[c]));
      if (buf.length >= ROWS_PER_CHUNK_FILE) {
        writeChunk(`${label}-${String(part++).padStart(2, "0")}`, buildMultiInserts(table, cols, buf), buf.length);
        buf = [];
      }
    }
    if (buf.length) {
      writeChunk(`${label}-${String(part++).padStart(2, "0")}`, buildMultiInserts(table, cols, buf), buf.length);
    }
  };

  exportTableChunked("customers", "ci_dim_customers", custCols, "client_key");
  exportTableChunked("sales", "ci_fact_sales", salesCols, "row_no");
  exportTableChunked("returns", "ci_fact_returns", retCols, "row_no");
  exportTableChunked("agg", "ci_agg_monthly", aggCols);
  exportTableChunked("catalog", "ci_dim_catalog", catCols);

  db.close();
  console.log(
    JSON.stringify({
      stage: "chunks_prepared",
      batchId,
      prepMs: Date.now() - t0,
      chunks: chunkFiles.length,
      localCheck,
      dryRun,
    }),
  );

  if (dryRun) {
    rmSync(chunkDir, { recursive: true, force: true });
    rmSync(stagingPath, { force: true });
    return;
  }

  let succeeded = false;
  try {
    for (let i = 0; i < chunkFiles.length; i++) {
      const c = chunkFiles[i];
      const tc = Date.now();
      d1File(c.path);
      console.log(
        JSON.stringify({
          stage: "chunk_uploaded",
          index: i + 1,
          total: chunkFiles.length,
          chunk: c.name,
          rows: c.rows,
          ms: Date.now() - tc,
        }),
      );
    }

    const activeAfter = d1Command("SELECT active_batch_id, mode FROM ci_csv_active WHERE id=1")[0]?.results?.[0];
    if (!activeAfter || activeAfter.mode !== "shadow" || activeAfter.active_batch_id !== null) {
      throw Error(`ERRO: ci_csv_active alterado inesperadamente: ${JSON.stringify(activeAfter)}`);
    }

    const receipt = {
      batchId,
      environment: "commercial-insight-hml",
      databaseId: HML_DB_UUID,
      mode: "shadow",
      activeBatchId: null,
      fileCount: allCsvNames.length,
      coverage: { from: minDate, to: maxDate, referenceDate: maxDate },
      counts: {
        salesRows: salesRowsCount,
        returnRows: returnRowsCount,
        customers: customerRowsCount,
        customerDuplicates,
        customerConflicts: customerConflicts.length,
        products: productRowsCount,
        ordersOpen: ordersRowsCount,
        macros: localCheck.macros_n,
        groups: localCheck.groups_n,
      },
      chunksUploaded: chunkFiles.length,
      elapsedMs: Date.now() - t0,
      completedAt: new Date().toISOString(),
    };
    writeFileSync(join(workDir, "shadow-batch.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
    console.log(JSON.stringify({ stage: "completed", ...receipt }));
    succeeded = true;
  } finally {
    if (succeeded) {
      rmSync(chunkDir, { recursive: true, force: true });
      rmSync(stagingPath, { force: true });
    }
  }
}

void main();
