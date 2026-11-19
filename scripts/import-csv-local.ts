import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  cleanCsvDisplay,
  createCsvRecordParser,
  CSV_SCHEMAS,
  deduplicateCustomers,
  normalizeCsvKey,
  parseCsvDate,
  parseScaledCsvAmount,
  resolveCsvColumnMap,
  type CsvRole,
} from "../shared/csv";

const SCALE = 4;

function parseArgs(argv: string[]) {
  let dir = process.env.CSV_DIR || "";
  let dbPath = ".wrangler/csv-homologation.sqlite";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir" && argv[i + 1]) dir = argv[++i];
    else if (argv[i] === "--db" && argv[i + 1]) dbPath = argv[++i];
  }
  if (!dir) {
    throw Error("Informe --dir com o diretório local dos CSVs do Power BI.");
  }
  return { dir: resolve(dir), dbPath: resolve(dbPath) };
}

async function streamFileCsv(
  filePath: string,
  onRecord: (record: string[], rowIndex: number) => void,
): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  const parser = createCsvRecordParser();
  const decoder = new TextDecoder("utf-8");
  let rowIndex = 0;

  await new Promise<void>((resolvePromise, rejectPromise) => {
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
      resolvePromise();
    });
    stream.on("error", rejectPromise);
  });

  return { bytes: statSync(filePath).size, sha256: hash.digest("hex") };
}

function findCsvFile(dir: string, candidates: string[]): string | null {
  for (const name of candidates) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

async function main() {
  const { dir, dbPath } = parseArgs(process.argv.slice(2));
  mkdirSync(dirname(dbPath), { recursive: true });
  const sql = new DatabaseSync(dbPath);
  sql.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;");

  const migrationSql = readFileSync(
    new URL("../migrations/0011_structured_csv_layer.sql", import.meta.url),
    "utf8",
  );
  sql.exec(migrationSql);

  const batchId = crypto.randomUUID();
  const ts = Math.floor(Date.now() / 1000);
  const tStart = performance.now();

  sql
    .prepare(
      "INSERT INTO ci_csv_batches(id,actor,owner,status,source_label,created,updated) VALUES(?,?,?,?,?,?,?)",
    )
    .run(batchId, "local-homologation", "local-homologation", "processing", "Homologação Local DAX CSVs", ts, ts);

  const productMacro = new Map<string, string>();
  const upsertFile = sql.prepare(
    `INSERT INTO ci_csv_files(batch_id,role,filename,sha256,bytes,row_count,duplicate_count,rejected_count,status,schema_json,updated)
     VALUES(?,?,?,?,?,?,?,?,'processed',?,?)
     ON CONFLICT(batch_id,role) DO UPDATE SET sha256=excluded.sha256,bytes=excluded.bytes,row_count=excluded.row_count,duplicate_count=excluded.duplicate_count,rejected_count=excluded.rejected_count,status='processed',updated=excluded.updated`,
  );

  const recordFile = (
    role: CsvRole,
    filePath: string,
    meta: { bytes: number; sha256: string },
    rows: number,
    duplicates: number,
    rejected: number,
    headers: string[],
  ) => {
    upsertFile.run(
      batchId,
      role,
      filePath.split(/[/\\]/).pop() ?? CSV_SCHEMAS[role].defaultFilename,
      meta.sha256,
      meta.bytes,
      rows,
      duplicates,
      rejected,
      JSON.stringify(headers),
      ts,
    );
  };

  // 1. Regions
  const regionsFile = findCsvFile(dir, ["Base Regionais.csv"]);
  if (regionsFile) {
    let headers: string[] = [];
    let map: Record<string, number> = {};
    const insert = sql.prepare(
      "INSERT OR REPLACE INTO ci_dim_regions(batch_id,state_key,state_name,regional_key,regional_raw,manager_key,manager_raw,region_name) VALUES(?,?,?,?,?,?,?,?)",
    );
    let rows = 0;
    let rejected = 0;
    sql.exec("BEGIN");
    const meta = await streamFileCsv(regionsFile, (rec, idx) => {
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
      insert.run(
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
    sql.exec("COMMIT");
    recordFile("regions", regionsFile, meta, rows, 0, rejected, headers);
  }

  // 2. Calendar
  const calFile = findCsvFile(dir, ["dCalendario.csv"]);
  if (calFile) {
    let headers: string[] = [];
    let map: Record<string, number> = {};
    const insert = sql.prepare(
      "INSERT OR IGNORE INTO ci_dim_calendar(batch_id,date,year,month,month_key,quarter) VALUES(?,?,?,?,?,?)",
    );
    let rows = 0;
    let rejected = 0;
    sql.exec("BEGIN");
    const meta = await streamFileCsv(calFile, (rec, idx) => {
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
      const year = Number(date.slice(0, 4));
      const month = Number(date.slice(5, 7));
      insert.run(batchId, date, year, month, date.slice(0, 7), Math.ceil(month / 3));
      rows++;
    });
    sql.exec("COMMIT");
    recordFile("calendar", calFile, meta, rows, 0, rejected, headers);
  }

  // 3. Products
  const prodFile = findCsvFile(dir, ["Base Produtos.csv"]);
  let productRowsCount = 0;
  if (prodFile) {
    let headers: string[] = [];
    let map: Record<string, number> = {};
    const insert = sql.prepare(
      "INSERT OR REPLACE INTO ci_dim_products(batch_id,product_key,product_raw,description,brand,macro_category_key,macro_category_raw,unit_liters,box_liters,pack_qty,unit_measure,abc_class) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    let rejected = 0;
    sql.exec("BEGIN");
    const meta = await streamFileCsv(prodFile, (rec, idx) => {
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
      insert.run(
        batchId,
        productKey,
        productRaw,
        cleanCsvDisplay(map.description !== undefined ? rec[map.description] : null),
        cleanCsvDisplay(map.brand !== undefined ? rec[map.brand] : null),
        macroKey,
        macroRaw,
        map.unitLiters !== undefined ? parseScaledCsvAmount(rec[map.unitLiters], SCALE) : null,
        map.boxLiters !== undefined ? parseScaledCsvAmount(rec[map.boxLiters], SCALE) : null,
        map.packQty !== undefined ? parseScaledCsvAmount(rec[map.packQty], SCALE) : null,
        cleanCsvDisplay(map.unitMeasure !== undefined ? rec[map.unitMeasure] : null),
        cleanCsvDisplay(map.abcClass !== undefined ? rec[map.abcClass] : null),
      );
      productRowsCount++;
    });
    sql.exec("COMMIT");
    recordFile("products", prodFile, meta, productRowsCount, 0, rejected, headers);
  }

  // 4. Customers
  const custFile = findCsvFile(dir, ["Base Clientes.csv"]);
  let customerRowsCount = 0;
  let customerDuplicateCount = 0;
  let customerConflicts: string[] = [];
  if (custFile) {
    let headers: string[] = [];
    let map: Record<string, number> = {};
    const rawList: Parameters<typeof deduplicateCustomers>[0] = [];
    const meta = await streamFileCsv(custFile, (rec, idx) => {
      if (idx === 0) {
        headers = rec.map((h) => h.trim());
        map = resolveCsvColumnMap("customers", headers).map;
        return;
      }
      rawList.push({
        client: rec[map.client],
        name: map.name !== undefined ? rec[map.name] : null,
        representative: map.representative !== undefined ? rec[map.representative] : null,
        state: map.state !== undefined ? rec[map.state] : null,
        regional: map.regional !== undefined ? rec[map.regional] : null,
        segment: map.segment !== undefined ? rec[map.segment] : null,
        saleType: map.saleType !== undefined ? rec[map.saleType] : null,
      });
    });
    const dedup = deduplicateCustomers(rawList);
    customerRowsCount = dedup.rows.length;
    customerDuplicateCount = dedup.duplicateCount;
    customerConflicts = dedup.conflicts;
    const insert = sql.prepare(
      "INSERT INTO ci_dim_customers(batch_id,client_key,client_raw,name,representative_key,representative_raw,state_key,regional_raw,segment,sale_type,source_rows) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    );
    sql.exec("BEGIN");
    for (const r of dedup.rows) {
      insert.run(
        batchId,
        r.clientKey,
        r.clientRaw,
        r.name,
        r.representativeKey,
        r.representativeRaw,
        r.stateKey,
        r.regionalRaw,
        r.segment,
        r.saleType,
        r.sourceRows,
      );
    }
    sql.exec("COMMIT");
    recordFile(
      "customers",
      custFile,
      meta,
      dedup.rows.length,
      dedup.duplicateCount,
      dedup.rejectedCount,
      headers,
    );
  }

  // 5. Sales (Faturamento)
  let minDate: string | null = null;
  let maxDate: string | null = null;
  let salesRowsCount = 0;
  const salesFile = findCsvFile(dir, ["Faturamento.csv"]);
  if (salesFile) {
    let headers: string[] = [];
    let map: Record<string, number> = {};
    const insert = sql.prepare(
      `INSERT INTO ci_fact_sales(
        batch_id,row_no,date,month_key,doc_no,client_key,client_raw,product_key,product_raw,
        group_key,group_raw,macro_key,state_key,municipality,channel,regional_raw,utilization,
        qty,liters,gross_amount,accounting_amount
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    let rejected = 0;
    sql.exec("BEGIN");
    const meta = await streamFileCsv(salesFile, (rec, idx) => {
      if (idx === 0) {
        headers = rec.map((h) => h.trim());
        map = resolveCsvColumnMap("sales", headers).map;
        return;
      }
      const date = parseCsvDate(rec[map.date]);
      const grossAmount = parseScaledCsvAmount(rec[map.amount], SCALE);
      if (!date || grossAmount === null) {
        rejected++;
        return;
      }
      if (!minDate || date < minDate) minDate = date;
      if (!maxDate || date > maxDate) maxDate = date;
      salesRowsCount++;
      const productKey = normalizeCsvKey(rec[map.product]);
      const macroKey = productKey ? productMacro.get(productKey) ?? null : null;
      insert.run(
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
        map.qty !== undefined ? parseScaledCsvAmount(rec[map.qty], SCALE) : null,
        map.liters !== undefined ? parseScaledCsvAmount(rec[map.liters], SCALE) : null,
        grossAmount,
        map.accountingAmount !== undefined ? parseScaledCsvAmount(rec[map.accountingAmount], SCALE) : null,
      );
    });
    sql.exec("COMMIT");
    recordFile("sales", salesFile, meta, salesRowsCount, 0, rejected, headers);
  }

  // 6. Returns (DEVOLUÇÃO.csv)
  let returnRowsCount = 0;
  const retFile = findCsvFile(dir, ["DEVOLUÇÃO.csv", "DEVOLUCAO.csv"]);
  if (retFile) {
    let headers: string[] = [];
    let map: Record<string, number> = {};
    const insert = sql.prepare(
      `INSERT INTO ci_fact_returns(
        batch_id,row_no,date,month_key,doc_no,client_key,client_raw,product_key,product_raw,
        group_key,group_raw,macro_key,state_key,qty,liters,return_amount
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    let rejected = 0;
    sql.exec("BEGIN");
    const meta = await streamFileCsv(retFile, (rec, idx) => {
      if (idx === 0) {
        headers = rec.map((h) => h.trim());
        map = resolveCsvColumnMap("returns", headers).map;
        return;
      }
      const date = parseCsvDate(rec[map.date]);
      const returnAmount = parseScaledCsvAmount(rec[map.amount], SCALE);
      if (!date || returnAmount === null) {
        rejected++;
        return;
      }
      if (!minDate || date < minDate) minDate = date;
      if (!maxDate || date > maxDate) maxDate = date;
      returnRowsCount++;
      const productKey = map.product !== undefined ? normalizeCsvKey(rec[map.product]) : null;
      const macroKey = productKey ? productMacro.get(productKey) ?? null : null;
      insert.run(
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
        map.qty !== undefined ? parseScaledCsvAmount(rec[map.qty], SCALE) : null,
        map.liters !== undefined ? parseScaledCsvAmount(rec[map.liters], SCALE) : null,
        returnAmount,
      );
    });
    sql.exec("COMMIT");
    recordFile("returns", retFile, meta, returnRowsCount, 0, rejected, headers);
  }

  // 7. Open Orders (Backlog)
  const ordFile = findCsvFile(dir, ["Base Pedidos.csv"]);
  let ordersCount = 0;
  if (ordFile) {
    let headers: string[] = [];
    let map: Record<string, number> = {};
    const insert = sql.prepare(
      "INSERT INTO ci_fact_orders_open(batch_id,row_no,doc_no,doc_date,client_key,client_raw,state_key,status,utilization,open_amount,original_amount) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    );
    sql.exec("BEGIN");
    const meta = await streamFileCsv(ordFile, (rec, idx) => {
      if (idx === 0) {
        headers = rec.map((h) => h.trim());
        map = resolveCsvColumnMap("orders", headers).map;
        return;
      }
      const docNo = cleanCsvDisplay(rec[map.docNo]);
      if (!docNo) return;
      ordersCount++;
      insert.run(
        batchId,
        ordersCount,
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
    sql.exec("COMMIT");
    recordFile("orders", ordFile, meta, ordersCount, 0, 0, headers);
  }

  // 8. Build aggregates and official catalog
  sql.exec("BEGIN");
  sql
    .prepare(
      `INSERT INTO ci_agg_monthly(
        batch_id,month_key,state_key,regional_key,manager_key,representative_key,
        macro_key,group_key,channel,segment,brand,gross_amount,return_amount,net_amount,sales_rows,return_rows
      )
      SELECT
        ?,month_key,state_key,regional_key,manager_key,representative_key,
        macro_key,group_key,channel,segment,brand,
        SUM(gross_amount),SUM(return_amount),SUM(gross_amount)-SUM(return_amount),SUM(sales_rows),SUM(return_rows)
      FROM (
        SELECT
          s.month_key,
          COALESCE(s.state_key,'') AS state_key,
          COALESCE(rg.regional_key,'') AS regional_key,
          COALESCE(rg.manager_key,'') AS manager_key,
          COALESCE(c.representative_key,'') AS representative_key,
          COALESCE(p.macro_category_key,s.macro_key,'') AS macro_key,
          COALESCE(s.group_key,'') AS group_key,
          COALESCE(s.channel,'') AS channel,
          COALESCE(c.segment,'') AS segment,
          COALESCE(p.brand,'') AS brand,
          s.gross_amount,0 AS return_amount,1 AS sales_rows,0 AS return_rows
        FROM ci_fact_sales s
        LEFT JOIN ci_dim_customers c ON c.batch_id=s.batch_id AND c.client_key=s.client_key
        LEFT JOIN ci_dim_products p ON p.batch_id=s.batch_id AND p.product_key=s.product_key
        LEFT JOIN ci_dim_regions rg ON rg.batch_id=s.batch_id AND rg.state_key=s.state_key
        WHERE s.batch_id=?
        UNION ALL
        SELECT
          r.month_key,
          COALESCE(r.state_key,'') AS state_key,
          COALESCE(rg.regional_key,'') AS regional_key,
          COALESCE(rg.manager_key,'') AS manager_key,
          COALESCE(c.representative_key,'') AS representative_key,
          COALESCE(p.macro_category_key,r.macro_key,'') AS macro_key,
          COALESCE(r.group_key,'') AS group_key,
          '' AS channel,
          COALESCE(c.segment,'') AS segment,
          COALESCE(p.brand,'') AS brand,
          0 AS gross_amount,r.return_amount,0 AS sales_rows,1 AS return_rows
        FROM ci_fact_returns r
        LEFT JOIN ci_dim_customers c ON c.batch_id=r.batch_id AND c.client_key=r.client_key
        LEFT JOIN ci_dim_products p ON p.batch_id=r.batch_id AND p.product_key=r.product_key
        LEFT JOIN ci_dim_regions rg ON rg.batch_id=r.batch_id AND rg.state_key=r.state_key
        WHERE r.batch_id=?
      )
      GROUP BY month_key,state_key,regional_key,manager_key,representative_key,macro_key,group_key,channel,segment,brand`,
    )
    .run(batchId, batchId, batchId);

  sql
    .prepare(
      "UPDATE ci_csv_batches SET status='validated',reference_date=?,coverage_from=?,coverage_to=?,sales_rows=?,return_rows=?,customer_rows=?,product_rows=?,updated=? WHERE id=?",
    )
    .run(maxDate, minDate, maxDate, salesRowsCount, returnRowsCount, customerRowsCount, productRowsCount, ts, batchId);
  sql
    .prepare("UPDATE ci_csv_active SET active_batch_id=?,mode='active',updated=?,actor='local-cli' WHERE id=1")
    .run(batchId, ts);
  sql.exec("COMMIT");

  const loadMs = Math.round(performance.now() - tStart);

  // Reconciliation & 15-Question Benchmark (NO PII printed)
  const money = (raw: unknown) => Number(raw || 0) / 10 ** SCALE;
  const timed = <T>(label: string, fn: () => T) => {
    const t0 = performance.now();
    const res = fn();
    return { label, ms: Number((performance.now() - t0).toFixed(2)), res };
  };

  const q1 = timed("Q1_clientes_distintos_base", () =>
    sql.prepare("SELECT COUNT(*) AS n FROM ci_dim_customers WHERE batch_id=?").get(batchId)!.n,
  );
  const q2 = timed("Q2_clientes_compradores_2026", () =>
    sql
      .prepare("SELECT COUNT(DISTINCT client_key) AS n FROM ci_fact_sales WHERE batch_id=? AND month_key BETWEEN '2026-01' AND '2026-12'")
      .get(batchId)!.n,
  );
  const q3 = timed("Q3_representantes_cadastrados", () =>
    sql
      .prepare("SELECT COUNT(DISTINCT representative_key) AS n FROM ci_dim_customers WHERE batch_id=? AND representative_key IS NOT NULL")
      .get(batchId)!.n,
  );
  const q4 = timed("Q4_representantes_com_vendas_2026", () =>
    sql
      .prepare(
        "SELECT COUNT(DISTINCT c.representative_key) AS n FROM ci_fact_sales s JOIN ci_dim_customers c ON c.batch_id=s.batch_id AND c.client_key=s.client_key WHERE s.batch_id=? AND s.month_key BETWEEN '2026-01' AND '2026-12' AND c.representative_key IS NOT NULL",
      )
      .get(batchId)!.n,
  );
  const q5 = timed("Q5_faturamento_bruto_2026", () =>
    money(
      sql
        .prepare("SELECT SUM(gross_amount) AS v FROM ci_agg_monthly WHERE batch_id=? AND month_key BETWEEN '2026-01' AND '2026-12'")
        .get(batchId)!.v,
    ),
  );
  const q6 = timed("Q6_faturamento_liquido_2026", () =>
    money(
      sql
        .prepare("SELECT SUM(net_amount) AS v FROM ci_agg_monthly WHERE batch_id=? AND month_key BETWEEN '2026-01' AND '2026-12'")
        .get(batchId)!.v,
    ),
  );
  const q7 = timed("Q7_devolucoes_2026", () =>
    money(
      sql
        .prepare("SELECT SUM(return_amount) AS v FROM ci_agg_monthly WHERE batch_id=? AND month_key BETWEEN '2026-01' AND '2026-12'")
        .get(batchId)!.v,
    ),
  );
  const prevEnd = (() => {
    if (!maxDate) return "2025-11-17";
    const year = Number(maxDate.slice(0, 4)) - 1;
    const month = Number(maxDate.slice(5, 7));
    const day = Number(maxDate.slice(8, 10));
    const clampedDay = Math.min(day, new Date(Date.UTC(year, month, 0)).getUTCDate());
    return `${year}-${String(month).padStart(2, "0")}-${String(clampedDay).padStart(2, "0")}`;
  })();

  const q8 = timed("Q8_crescimento_ytd_vs_2025", () => {
    const net26 = money(
      sql
        .prepare("SELECT SUM(gross_amount) AS g FROM ci_fact_sales WHERE batch_id=? AND date BETWEEN '2026-01-01' AND ?")
        .get(batchId, maxDate)!.g,
    ) -
      money(
        sql
          .prepare("SELECT SUM(return_amount) AS r FROM ci_fact_returns WHERE batch_id=? AND date BETWEEN '2026-01-01' AND ?")
          .get(batchId, maxDate)!.r,
      );
    const net25 = money(
      sql
        .prepare("SELECT SUM(gross_amount) AS g FROM ci_fact_sales WHERE batch_id=? AND date BETWEEN '2025-01-01' AND ?")
        .get(batchId, prevEnd)!.g,
    ) -
      money(
        sql
          .prepare("SELECT SUM(return_amount) AS r FROM ci_fact_returns WHERE batch_id=? AND date BETWEEN '2025-01-01' AND ?")
          .get(batchId, prevEnd)!.r,
      );
    return { net26, net25, diff: net26 - net25, pct: net25 > 0 ? ((net26 - net25) / net25) * 100 : null };
  });
  const q9 = timed("Q9_clientes_maior_queda_count", () =>
    sql
      .prepare(
        `WITH s AS (
           SELECT client_key,
             SUM(CASE WHEN date BETWEEN '2026-01-01' AND ? THEN gross_amount ELSE 0 END) AS c,
             SUM(CASE WHEN date BETWEEN '2025-01-01' AND ? THEN gross_amount ELSE 0 END) AS p
           FROM ci_fact_sales WHERE batch_id=? GROUP BY client_key
         ) SELECT COUNT(*) AS declining FROM s WHERE c < p`,
      )
      .get(maxDate, prevEnd, batchId)!.declining,
  );
  const q10 = timed("Q10_produtos_maior_crescimento_count", () =>
    sql
      .prepare(
        `WITH s AS (
           SELECT product_key,
             SUM(CASE WHEN date BETWEEN '2026-01-01' AND ? THEN gross_amount ELSE 0 END) AS c,
             SUM(CASE WHEN date BETWEEN '2025-01-01' AND ? THEN gross_amount ELSE 0 END) AS p
           FROM ci_fact_sales WHERE batch_id=? GROUP BY product_key
         ) SELECT COUNT(*) AS growing FROM s WHERE c > p`,
      )
      .get(maxDate, prevEnd, batchId)!.growing,
  );
  const q11 = timed("Q11_suco_vinho_excluindo_granel_2026", () => {
    const r = sql
      .prepare(
        `SELECT SUM(gross_amount) AS gross, SUM(return_amount) AS ret, SUM(net_amount) AS net
         FROM ci_agg_monthly
         WHERE batch_id=? AND month_key BETWEEN '2026-01' AND '2026-12'
           AND macro_key IN ('SUCO','VINHO')
           AND group_key NOT LIKE '%GRANEL%'`,
      )
      .get(batchId)!;
    return { gross: money(r.gross), returns: money(r.ret), net: money(r.net) };
  });
  const q12 = timed("Q12_participacao_categorias_2026", () =>
    sql
      .prepare(
        `SELECT macro_key AS category, SUM(gross_amount) AS gross, SUM(net_amount) AS net
         FROM ci_agg_monthly
         WHERE batch_id=? AND month_key BETWEEN '2026-01' AND '2026-12'
         GROUP BY macro_key ORDER BY net DESC`,
      )
      .all(batchId)
      .map((row) => ({ category: row.category || "(Sem macro)", gross: money(row.gross), net: money(row.net) })),
  );
  const q13 = timed("Q13_representantes_crescimento_count", () =>
    sql
      .prepare(
        `SELECT representative_key,
           SUM(CASE WHEN date BETWEEN '2026-01-01' AND ? THEN amount ELSE 0 END) AS cur,
           SUM(CASE WHEN date BETWEEN '2025-01-01' AND ? THEN amount ELSE 0 END) AS prev
         FROM (
           SELECT s.date, c.representative_key, s.gross_amount AS amount
           FROM ci_fact_sales s JOIN ci_dim_customers c ON c.batch_id=s.batch_id AND c.client_key=s.client_key
           WHERE s.batch_id=? AND c.representative_key IS NOT NULL
           UNION ALL
           SELECT r.date, c.representative_key, -r.return_amount AS amount
           FROM ci_fact_returns r JOIN ci_dim_customers c ON c.batch_id=r.batch_id AND c.client_key=r.client_key
           WHERE r.batch_id=? AND c.representative_key IS NOT NULL
         ) GROUP BY representative_key HAVING cur > prev`,
      )
      .all(maxDate, prevEnd, batchId, batchId).length,
  );
  const q14 = timed("Q14_clientes_deixaram_comprar_2025_vs_2026", () =>
    sql
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT client_key,
             SUM(CASE WHEN month_key BETWEEN '2025-01' AND '2025-12' THEN gross_amount ELSE 0 END) AS y25,
             SUM(CASE WHEN month_key BETWEEN '2026-01' AND '2026-12' THEN gross_amount ELSE 0 END) AS y26
           FROM ci_fact_sales WHERE batch_id=? GROUP BY client_key HAVING y25 > 0 AND y26 = 0
         )`,
      )
      .get(batchId)!.n,
  );
  const q15 = timed("Q15_preparo_visita_lookup_ms", () =>
    sql
      .prepare(
        "SELECT COUNT(*) AS rows, COUNT(DISTINCT month_key) AS months FROM ci_fact_sales WHERE batch_id=? AND client_key=(SELECT client_key FROM ci_dim_customers WHERE batch_id=? LIMIT 1)",
      )
      .get(batchId, batchId),
  );

  // Example filters A, B, C verification
  const filterB = money(
    sql
      .prepare(
        "SELECT SUM(gross_amount) AS v FROM ci_agg_monthly WHERE batch_id=? AND month_key BETWEEN '2026-01' AND '2026-12' AND group_key LIKE '%GRANEL%'",
      )
      .get(batchId)!.v,
  );
  const filterC = money(
    sql
      .prepare(
        "SELECT SUM(gross_amount) AS v FROM ci_agg_monthly WHERE batch_id=? AND month_key BETWEEN '2026-01' AND '2026-12' AND state_key='SP' AND macro_key IN ('SUCO','ESPUMANTE')",
      )
      .get(batchId)!.v,
  );
  const docStats = sql
    .prepare(
      "SELECT COUNT(DISTINCT doc_no) AS nf_2026 FROM ci_fact_sales WHERE batch_id=? AND month_key BETWEEN '2026-01' AND '2026-12' AND doc_no IS NOT NULL AND doc_no<>''",
    )
    .get(batchId)!;

  console.log(
    JSON.stringify(
      {
        batchId,
        dbPath,
        loadMs,
        coverage: { from: minDate, to: maxDate },
        counts: {
          salesRows: salesRowsCount,
          returnRows: returnRowsCount,
          distinctCustomers: customerRowsCount,
          customerDuplicatesRemoved: customerDuplicateCount,
          customerAttributeConflicts: customerConflicts.length,
          products: productRowsCount,
          openOrders: ordersCount,
          distinctInvoices2026: docStats.nf_2026,
          ticketPorComprador2026: Number((q6.res / Number(q2.res)).toFixed(2)),
          ticketPorNF2026Net: Number((q6.res / Number(docStats.nf_2026)).toFixed(2)),
          ticketPorNF2026Gross: Number((q5.res / Number(docStats.nf_2026)).toFixed(2)),
        },
        filterChecks: {
          exampleA_suco_vinho_excl_granel_2026: q11.res,
          exampleB_granel_only_2026_gross: filterB,
          exampleC_suco_espumante_sp_2026_gross: filterC,
        },
        benchmarks: [q1, q2, q3, q4, q5, q6, q7, q8, q9, q10, q11, q12, q13, q14, q15].map((b) => ({
          question: b.label,
          ms: b.ms,
          result: b.res,
        })),
      },
      null,
      2,
    ),
  );
  sql.close();
}

void main();
