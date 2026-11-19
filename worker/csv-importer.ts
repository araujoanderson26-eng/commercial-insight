import { createHash } from "node:crypto";
import { z } from "zod";
import {
  cleanCsvDisplay,
  createCsvRecordParser,
  csvRoles,
  CSV_SCHEMAS,
  deduplicateCustomers,
  normalizeCsvKey,
  parseCsvDate,
  parseScaledCsvAmount,
  resolveCsvColumnMap,
  type CsvRole,
} from "../shared/csv";
import { audit, body, fail, json, now, stmt, type DbUser, type Env } from "./core";

type CsvEnv = Env & { BUCKET?: R2Bucket; CSV_MAX_FILE_BYTES?: string };

export type CsvBatchRow = {
  id: string;
  actor: string;
  owner: string;
  status: "staging" | "processing" | "validated" | "active" | "failed" | "rolled_back";
  source_label: string;
  reference_date: string | null;
  coverage_from: string | null;
  coverage_to: string | null;
  file_count: number;
  sales_rows: number;
  return_rows: number;
  customer_rows: number;
  product_rows: number;
  summary_json: string | null;
  diff_json: string | null;
  validation_json: string | null;
  error: string | null;
  created: number;
  updated: number;
  activated_at: number | null;
};

type CsvFileRow = {
  batch_id: string;
  role: CsvRole;
  filename: string;
  sha256: string;
  bytes: number;
  object_key: string | null;
  row_count: number;
  duplicate_count: number;
  rejected_count: number;
  status: string;
  schema_json: string | null;
  updated: number;
};

type ActiveCsvRow = {
  id: number;
  active_batch_id: string | null;
  previous_batch_id: string | null;
  mode: "shadow" | "active";
  updated: number;
  actor: string | null;
};

const CSV_PREFIX = "commercial-insight/csv/";
const DEFAULT_MAX_CSV_BYTES = 256 * 1024 * 1024;
const MONETARY_SCALE = 4;

function isMissingCsvSchemaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /no such table:\s*ci_(?:csv_|dim_|fact_|agg_)/i.test(msg);
}

export async function activeCsvBatch(
  e: Env,
): Promise<{ batchId: string; referenceDate: string | null; mode: "shadow" | "active" } | null> {
  try {
    const active = await stmt(
      e,
      "SELECT a.active_batch_id,a.mode,b.reference_date FROM ci_csv_active a LEFT JOIN ci_csv_batches b ON b.id=a.active_batch_id WHERE a.id=1",
    ).first<{ active_batch_id: string | null; mode: "shadow" | "active"; reference_date: string | null }>();
    if (!active || active.mode !== "active" || !active.active_batch_id) return null;
    return {
      batchId: active.active_batch_id,
      referenceDate: active.reference_date,
      mode: active.mode,
    };
  } catch (err) {
    if (isMissingCsvSchemaError(err)) return null;
    throw err;
  }
}

async function execChunkedInserts(
  e: Env,
  sqlPrefix: string,
  columnCount: number,
  rows: (string | number | null)[][],
  onConflict = "",
) {
  if (!rows.length) return;
  const maxRowsPerStmt = Math.max(1, Math.floor(80 / columnCount));
  const placeholder = "(" + Array(columnCount).fill("?").join(",") + ")";
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += maxRowsPerStmt) {
    const slice = rows.slice(i, i + maxRowsPerStmt);
    const values = slice.map(() => placeholder).join(",");
    stmts.push(
      stmt(
        e,
        `${sqlPrefix} VALUES ${values}${onConflict ? " " + onConflict : ""}`,
        ...slice.flat(),
      ),
    );
    if (stmts.length >= 25) {
      await e.DB.batch(stmts.splice(0, stmts.length));
    }
  }
  if (stmts.length) await e.DB.batch(stmts);
}

async function streamR2CsvRows(
  object: R2ObjectBody,
  onRecord: (record: string[], rowIndex: number) => void | Promise<void>,
) {
  const reader = object.body.getReader();
  const decoder = new TextDecoder("utf-8");
  const parser = createCsvRecordParser();
  let rowIndex = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const textChunk = decoder.decode(value, { stream: true });
    if (!textChunk) continue;
    const records = parser.push(textChunk);
    for (const rec of records) {
      await onRecord(rec, rowIndex++);
    }
  }
  const tailText = decoder.decode();
  if (tailText) {
    for (const rec of parser.push(tailText)) {
      await onRecord(rec, rowIndex++);
    }
  }
  for (const rec of parser.finish()) {
    await onRecord(rec, rowIndex++);
  }
}

export async function processCsvBatch(e: Env, batchId: string) {
  const bucket = (e as CsvEnv).BUCKET;
  if (!bucket) fail(503, "O armazenamento R2 dos arquivos CSV não está configurado.");
  const batch = await stmt(e, "SELECT * FROM ci_csv_batches WHERE id=?", batchId).first<CsvBatchRow>();
  if (!batch) fail(404, "Lote CSV não encontrado.");

  const files = (
    await stmt(e, "SELECT * FROM ci_csv_files WHERE batch_id=? ORDER BY role", batchId).all<CsvFileRow>()
  ).results;
  if (!files.length) fail(400, "Nenhum arquivo CSV foi enviado para este lote.");

  await stmt(
    e,
    "UPDATE ci_csv_batches SET status='processing',error=NULL,updated=? WHERE id=?",
    now(),
    batchId,
  ).run();

  try {
    // Clear previous derived data for idempotent re-processing of this staged batch
    await e.DB.batch([
      stmt(e, "DELETE FROM ci_agg_monthly WHERE batch_id=?", batchId),
      stmt(e, "DELETE FROM ci_dim_catalog WHERE batch_id=?", batchId),
      stmt(e, "DELETE FROM ci_fact_sales WHERE batch_id=?", batchId),
      stmt(e, "DELETE FROM ci_fact_returns WHERE batch_id=?", batchId),
      stmt(e, "DELETE FROM ci_fact_orders_open WHERE batch_id=?", batchId),
      stmt(e, "DELETE FROM ci_dim_customers WHERE batch_id=?", batchId),
      stmt(e, "DELETE FROM ci_dim_products WHERE batch_id=?", batchId),
      stmt(e, "DELETE FROM ci_dim_regions WHERE batch_id=?", batchId),
      stmt(e, "DELETE FROM ci_dim_calendar WHERE batch_id=?", batchId),
    ]);

    const productMacroByKey = new Map<string, string>();
    const stats: Record<string, { rows: number; duplicates: number; rejected: number }> = {};

    const readRoleRecords = async (role: CsvRole) => {
      const file = files.find((f) => f.role === role);
      if (!file || !file.object_key) return null;
      const obj = await bucket.get(file.object_key);
      if (!obj) fail(404, `Arquivo staged ausente no R2 para o papel "${role}".`);
      return { file, obj };
    };

    // 1. Regions
    const regLoaded = await readRoleRecords("regions");
    if (regLoaded) {
      let headers: string[] | null = null;
      let map: Record<string, number> = {};
      const rows: (string | number | null)[][] = [];
      let rejected = 0;
      await streamR2CsvRows(regLoaded.obj, (rec, idx) => {
        if (idx === 0) {
          headers = rec.map((h) => h.trim());
          const resolved = resolveCsvColumnMap("regions", headers);
          if (resolved.missingRequired.length) {
            fail(422, `Base Regionais: colunas obrigatórias ausentes: ${resolved.missingRequired.join(", ")}`);
          }
          map = resolved.map;
          return;
        }
        const stateKey = normalizeCsvKey(rec[map.state]);
        if (!stateKey) {
          rejected++;
          return;
        }
        rows.push([
          batchId,
          stateKey,
          cleanCsvDisplay(map.stateName !== undefined ? rec[map.stateName] : null),
          normalizeCsvKey(rec[map.regional]),
          cleanCsvDisplay(rec[map.regional]),
          normalizeCsvKey(map.manager !== undefined ? rec[map.manager] : null),
          cleanCsvDisplay(map.manager !== undefined ? rec[map.manager] : null),
          cleanCsvDisplay(map.regionName !== undefined ? rec[map.regionName] : null),
        ]);
      });
      await execChunkedInserts(
        e,
        "INSERT INTO ci_dim_regions(batch_id,state_key,state_name,regional_key,regional_raw,manager_key,manager_raw,region_name)",
        8,
        rows,
        "ON CONFLICT(batch_id,state_key) DO UPDATE SET state_name=excluded.state_name,regional_key=excluded.regional_key,regional_raw=excluded.regional_raw,manager_key=excluded.manager_key,manager_raw=excluded.manager_raw,region_name=excluded.region_name",
      );
      stats.regions = { rows: rows.length, duplicates: 0, rejected };
      await stmt(
        e,
        "UPDATE ci_csv_files SET row_count=?,duplicate_count=0,rejected_count=?,status='processed',schema_json=?,updated=? WHERE batch_id=? AND role='regions'",
        rows.length,
        rejected,
        JSON.stringify(headers ?? []),
        now(),
        batchId,
      ).run();
    }

    // 2. Calendar
    const calLoaded = await readRoleRecords("calendar");
    if (calLoaded) {
      let headers: string[] | null = null;
      let map: Record<string, number> = {};
      const rows: (string | number | null)[][] = [];
      let rejected = 0;
      await streamR2CsvRows(calLoaded.obj, (rec, idx) => {
        if (idx === 0) {
          headers = rec.map((h) => h.trim());
          const resolved = resolveCsvColumnMap("calendar", headers);
          if (resolved.missingRequired.length) {
            fail(422, `dCalendario: colunas obrigatórias ausentes: ${resolved.missingRequired.join(", ")}`);
          }
          map = resolved.map;
          return;
        }
        const date = parseCsvDate(rec[map.date]);
        if (!date) {
          rejected++;
          return;
        }
        const year = Number(date.slice(0, 4));
        const month = Number(date.slice(5, 7));
        const quarter = Math.ceil(month / 3);
        rows.push([batchId, date, year, month, date.slice(0, 7), quarter]);
      });
      await execChunkedInserts(
        e,
        "INSERT INTO ci_dim_calendar(batch_id,date,year,month,month_key,quarter)",
        6,
        rows,
        "ON CONFLICT(batch_id,date) DO NOTHING",
      );
      stats.calendar = { rows: rows.length, duplicates: 0, rejected };
      await stmt(
        e,
        "UPDATE ci_csv_files SET row_count=?,duplicate_count=0,rejected_count=?,status='processed',schema_json=?,updated=? WHERE batch_id=? AND role='calendar'",
        rows.length,
        rejected,
        JSON.stringify(headers ?? []),
        now(),
        batchId,
      ).run();
    }

    // 3. Products
    const prodLoaded = await readRoleRecords("products");
    if (prodLoaded) {
      let headers: string[] | null = null;
      let map: Record<string, number> = {};
      const rows: (string | number | null)[][] = [];
      let rejected = 0;
      await streamR2CsvRows(prodLoaded.obj, (rec, idx) => {
        if (idx === 0) {
          headers = rec.map((h) => h.trim());
          const resolved = resolveCsvColumnMap("products", headers);
          if (resolved.missingRequired.length) {
            fail(422, `Base Produtos: colunas obrigatórias ausentes: ${resolved.missingRequired.join(", ")}`);
          }
          map = resolved.map;
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
        if (macroKey) productMacroByKey.set(productKey, macroKey);
        rows.push([
          batchId,
          productKey,
          productRaw,
          cleanCsvDisplay(map.description !== undefined ? rec[map.description] : null),
          cleanCsvDisplay(map.brand !== undefined ? rec[map.brand] : null),
          macroKey,
          macroRaw,
          map.unitLiters !== undefined ? parseScaledCsvAmount(rec[map.unitLiters], MONETARY_SCALE, true) : null,
          map.boxLiters !== undefined ? parseScaledCsvAmount(rec[map.boxLiters], MONETARY_SCALE, true) : null,
          map.packQty !== undefined ? parseScaledCsvAmount(rec[map.packQty], MONETARY_SCALE, true) : null,
          cleanCsvDisplay(map.unitMeasure !== undefined ? rec[map.unitMeasure] : null),
          cleanCsvDisplay(map.abcClass !== undefined ? rec[map.abcClass] : null),
        ]);
      });
      await execChunkedInserts(
        e,
        "INSERT INTO ci_dim_products(batch_id,product_key,product_raw,description,brand,macro_category_key,macro_category_raw,unit_liters,box_liters,pack_qty,unit_measure,abc_class)",
        12,
        rows,
        "ON CONFLICT(batch_id,product_key) DO UPDATE SET description=excluded.description,brand=excluded.brand,macro_category_key=excluded.macro_category_key,macro_category_raw=excluded.macro_category_raw",
      );
      stats.products = { rows: rows.length, duplicates: 0, rejected };
      await stmt(
        e,
        "UPDATE ci_csv_files SET row_count=?,duplicate_count=0,rejected_count=?,status='processed',schema_json=?,updated=? WHERE batch_id=? AND role='products'",
        rows.length,
        rejected,
        JSON.stringify(headers ?? []),
        now(),
        batchId,
      ).run();
    }

    // 4. Customers (deduplicated strictly by Código Cliente)
    let customerConflicts: string[] = [];
    const custLoaded = await readRoleRecords("customers");
    if (custLoaded) {
      let headers: string[] | null = null;
      let map: Record<string, number> = {};
      const rawCustomerRecords: Parameters<typeof deduplicateCustomers>[0] = [];
      await streamR2CsvRows(custLoaded.obj, (rec, idx) => {
        if (idx === 0) {
          headers = rec.map((h) => h.trim());
          const resolved = resolveCsvColumnMap("customers", headers);
          if (resolved.missingRequired.length) {
            fail(422, `Base Clientes: colunas obrigatórias ausentes: ${resolved.missingRequired.join(", ")}`);
          }
          map = resolved.map;
          return;
        }
        rawCustomerRecords.push({
          client: rec[map.client],
          name: map.name !== undefined ? rec[map.name] : null,
          representative: map.representative !== undefined ? rec[map.representative] : null,
          state: map.state !== undefined ? rec[map.state] : null,
          regional: map.regional !== undefined ? rec[map.regional] : null,
          segment: map.segment !== undefined ? rec[map.segment] : null,
          saleType: map.saleType !== undefined ? rec[map.saleType] : null,
        });
      });
      const dedup = deduplicateCustomers(rawCustomerRecords);
      customerConflicts = dedup.conflicts;
      await execChunkedInserts(
        e,
        "INSERT INTO ci_dim_customers(batch_id,client_key,client_raw,name,representative_key,representative_raw,state_key,regional_raw,segment,sale_type,source_rows)",
        11,
        dedup.rows.map((r) => [
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
        ]),
      );
      stats.customers = {
        rows: dedup.rows.length,
        duplicates: dedup.duplicateCount,
        rejected: dedup.rejectedCount,
      };
      await stmt(
        e,
        "UPDATE ci_csv_files SET row_count=?,duplicate_count=?,rejected_count=?,status='processed',schema_json=?,updated=? WHERE batch_id=? AND role='customers'",
        dedup.rows.length,
        dedup.duplicateCount,
        dedup.rejectedCount,
        JSON.stringify(headers ?? []),
        now(),
        batchId,
      ).run();
    }

    // 5. Sales (Faturamento)
    let minDate: string | null = null;
    let maxDate: string | null = null;
    const salesLoaded = await readRoleRecords("sales");
    if (salesLoaded) {
      let headers: string[] | null = null;
      let map: Record<string, number> = {};
      let rowNo = 0;
      let rejected = 0;
      const chunkBuffer: (string | number | null)[][] = [];
      const flush = async () => {
        if (!chunkBuffer.length) return;
        const copy = chunkBuffer.splice(0, chunkBuffer.length);
        await execChunkedInserts(
          e,
          "INSERT INTO ci_fact_sales(batch_id,row_no,date,month_key,doc_no,client_key,client_raw,product_key,product_raw,group_key,group_raw,macro_key,state_key,municipality,channel,regional_raw,utilization,qty,liters,gross_amount,accounting_amount)",
          21,
          copy,
        );
      };
      await streamR2CsvRows(salesLoaded.obj, async (rec, idx) => {
        if (idx === 0) {
          headers = rec.map((h) => h.trim());
          const resolved = resolveCsvColumnMap("sales", headers);
          if (resolved.missingRequired.length) {
            fail(422, `Faturamento: colunas obrigatórias ausentes: ${resolved.missingRequired.join(", ")}`);
          }
          map = resolved.map;
          return;
        }
        const date = parseCsvDate(rec[map.date]);
        const grossAmount = parseScaledCsvAmount(rec[map.amount], MONETARY_SCALE);
        if (!date || grossAmount === null) {
          rejected++;
          return;
        }
        if (!minDate || date < minDate) minDate = date;
        if (!maxDate || date > maxDate) maxDate = date;
        rowNo++;
        const productKey = normalizeCsvKey(rec[map.product]);
        const macroKey = productKey ? productMacroByKey.get(productKey) ?? null : null;
        chunkBuffer.push([
          batchId,
          rowNo,
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
          map.qty !== undefined ? parseScaledCsvAmount(rec[map.qty], MONETARY_SCALE, true) : null,
          map.liters !== undefined ? parseScaledCsvAmount(rec[map.liters], MONETARY_SCALE, true) : null,
          grossAmount,
          map.accountingAmount !== undefined ? parseScaledCsvAmount(rec[map.accountingAmount], MONETARY_SCALE) : null,
        ]);
        if (chunkBuffer.length >= 80) await flush();
      });
      await flush();
      stats.sales = { rows: rowNo, duplicates: 0, rejected };
      await stmt(
        e,
        "UPDATE ci_csv_files SET row_count=?,duplicate_count=0,rejected_count=?,status='processed',schema_json=?,updated=? WHERE batch_id=? AND role='sales'",
        rowNo,
        rejected,
        JSON.stringify(headers ?? []),
        now(),
        batchId,
      ).run();
    }

    // 6. Returns (DEVOLUÇÃO - multiline RFC-4180 safe)
    const retLoaded = await readRoleRecords("returns");
    if (retLoaded) {
      let headers: string[] | null = null;
      let map: Record<string, number> = {};
      let rowNo = 0;
      let rejected = 0;
      const chunkBuffer: (string | number | null)[][] = [];
      const flush = async () => {
        if (!chunkBuffer.length) return;
        const copy = chunkBuffer.splice(0, chunkBuffer.length);
        await execChunkedInserts(
          e,
          "INSERT INTO ci_fact_returns(batch_id,row_no,date,month_key,doc_no,client_key,client_raw,product_key,product_raw,group_key,group_raw,macro_key,state_key,qty,liters,return_amount)",
          16,
          copy,
        );
      };
      await streamR2CsvRows(retLoaded.obj, async (rec, idx) => {
        if (idx === 0) {
          headers = rec.map((h) => h.trim());
          const resolved = resolveCsvColumnMap("returns", headers);
          if (resolved.missingRequired.length) {
            fail(422, `Devoluções: colunas obrigatórias ausentes: ${resolved.missingRequired.join(", ")}`);
          }
          map = resolved.map;
          return;
        }
        const date = parseCsvDate(rec[map.date]);
        const returnAmount = parseScaledCsvAmount(rec[map.amount], MONETARY_SCALE);
        if (!date || returnAmount === null) {
          rejected++;
          return;
        }
        if (!minDate || date < minDate) minDate = date;
        if (!maxDate || date > maxDate) maxDate = date;
        rowNo++;
        const productKey = map.product !== undefined ? normalizeCsvKey(rec[map.product]) : null;
        const macroKey = productKey ? productMacroByKey.get(productKey) ?? null : null;
        chunkBuffer.push([
          batchId,
          rowNo,
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
          map.qty !== undefined ? parseScaledCsvAmount(rec[map.qty], MONETARY_SCALE, true) : null,
          map.liters !== undefined ? parseScaledCsvAmount(rec[map.liters], MONETARY_SCALE, true) : null,
          returnAmount,
        ]);
        if (chunkBuffer.length >= 80) await flush();
      });
      await flush();
      stats.returns = { rows: rowNo, duplicates: 0, rejected };
      await stmt(
        e,
        "UPDATE ci_csv_files SET row_count=?,duplicate_count=0,rejected_count=?,status='processed',schema_json=?,updated=? WHERE batch_id=? AND role='returns'",
        rowNo,
        rejected,
        JSON.stringify(headers ?? []),
        now(),
        batchId,
      ).run();
    }

    // 7. Open Orders (Backlog only — strictly isolated from invoiced revenue)
    const ordLoaded = await readRoleRecords("orders");
    if (ordLoaded) {
      let headers: string[] | null = null;
      let map: Record<string, number> = {};
      const rows: (string | number | null)[][] = [];
      let rowNo = 0;
      await streamR2CsvRows(ordLoaded.obj, (rec, idx) => {
        if (idx === 0) {
          headers = rec.map((h) => h.trim());
          const resolved = resolveCsvColumnMap("orders", headers);
          map = resolved.map;
          return;
        }
        const docNo = cleanCsvDisplay(rec[map.docNo]);
        if (!docNo) return;
        rowNo++;
        rows.push([
          batchId,
          rowNo,
          docNo,
          map.date !== undefined ? parseCsvDate(rec[map.date]) : null,
          map.client !== undefined ? normalizeCsvKey(rec[map.client]) : null,
          map.client !== undefined ? cleanCsvDisplay(rec[map.client]) : null,
          map.state !== undefined ? normalizeCsvKey(rec[map.state]) : null,
          "aberto",
          map.utilization !== undefined ? cleanCsvDisplay(rec[map.utilization]) : null,
          map.openAmount !== undefined ? parseScaledCsvAmount(rec[map.openAmount], MONETARY_SCALE) : null,
          map.originalAmount !== undefined ? parseScaledCsvAmount(rec[map.originalAmount], MONETARY_SCALE) : null,
        ]);
      });
      await execChunkedInserts(
        e,
        "INSERT INTO ci_fact_orders_open(batch_id,row_no,doc_no,doc_date,client_key,client_raw,state_key,status,utilization,open_amount,original_amount)",
        11,
        rows,
      );
      stats.orders = { rows: rowNo, duplicates: 0, rejected: 0 };
      await stmt(
        e,
        "UPDATE ci_csv_files SET row_count=?,duplicate_count=0,rejected_count=0,status='processed',schema_json=?,updated=? WHERE batch_id=? AND role='orders'",
        rowNo,
        JSON.stringify(headers ?? []),
        now(),
        batchId,
      ).run();
    }

    // Build pre-aggregated monthly table and authorized catalog
    await rebuildAggregatesAndCatalog(e, batchId);

    const diff = await computeBatchDiff(e, batchId);
    const refDate = batch.reference_date || maxDate;

    await stmt(
      e,
      "UPDATE ci_csv_batches SET status='processing',reference_date=?,coverage_from=?,coverage_to=?,file_count=?,sales_rows=?,return_rows=?,customer_rows=?,product_rows=?,summary_json=?,diff_json=?,updated=? WHERE id=?",
      refDate,
      minDate,
      maxDate,
      files.length,
      stats.sales?.rows ?? 0,
      stats.returns?.rows ?? 0,
      stats.customers?.rows ?? 0,
      stats.products?.rows ?? 0,
      JSON.stringify({ stats, customerConflicts }),
      JSON.stringify(diff),
      now(),
      batchId,
    ).run();

    return { batchId, stats, customerConflicts, diff, coverage: { from: minDate, to: maxDate } };
  } catch (err) {
    const msg = err instanceof Error ? err.message.slice(0, 1500) : "Erro ao processar CSVs.";
    await stmt(e, "UPDATE ci_csv_batches SET status='failed',error=?,updated=? WHERE id=?", msg, now(), batchId).run();
    throw err;
  }
}

export async function rebuildAggregatesAndCatalog(e: Env, batchId: string) {
  await e.DB.batch([
    stmt(e, "DELETE FROM ci_agg_monthly WHERE batch_id=?", batchId),
    stmt(e, "DELETE FROM ci_dim_catalog WHERE batch_id=?", batchId),
    stmt(
      e,
      `INSERT INTO ci_agg_monthly(
        batch_id,month_key,state_key,regional_key,manager_key,representative_key,
        macro_key,group_key,channel,segment,brand,gross_amount,return_amount,net_amount,sales_rows,return_rows
      )
      SELECT
        ?,
        month_key,
        state_key,
        regional_key,
        manager_key,
        representative_key,
        macro_key,
        group_key,
        channel,
        segment,
        brand,
        SUM(gross_amount),
        SUM(return_amount),
        SUM(gross_amount)-SUM(return_amount),
        SUM(sales_rows),
        SUM(return_rows)
      FROM (
        SELECT
          s.month_key AS month_key,
          COALESCE(s.state_key,'') AS state_key,
          COALESCE(rg.regional_key,'') AS regional_key,
          COALESCE(rg.manager_key,'') AS manager_key,
          COALESCE(c.representative_key,'') AS representative_key,
          COALESCE(p.macro_category_key,s.macro_key,'') AS macro_key,
          COALESCE(s.group_key,'') AS group_key,
          COALESCE(s.channel,'') AS channel,
          COALESCE(c.segment,'') AS segment,
          COALESCE(p.brand,'') AS brand,
          s.gross_amount AS gross_amount,
          0 AS return_amount,
          1 AS sales_rows,
          0 AS return_rows
        FROM ci_fact_sales s
        LEFT JOIN ci_dim_customers c ON c.batch_id=s.batch_id AND c.client_key=s.client_key
        LEFT JOIN ci_dim_products p ON p.batch_id=s.batch_id AND p.product_key=s.product_key
        LEFT JOIN ci_dim_regions rg ON rg.batch_id=s.batch_id AND rg.state_key=s.state_key
        WHERE s.batch_id=?
        UNION ALL
        SELECT
          r.month_key AS month_key,
          COALESCE(r.state_key,'') AS state_key,
          COALESCE(rg.regional_key,'') AS regional_key,
          COALESCE(rg.manager_key,'') AS manager_key,
          COALESCE(c.representative_key,'') AS representative_key,
          COALESCE(p.macro_category_key,r.macro_key,'') AS macro_key,
          COALESCE(r.group_key,'') AS group_key,
          '' AS channel,
          COALESCE(c.segment,'') AS segment,
          COALESCE(p.brand,'') AS brand,
          0 AS gross_amount,
          r.return_amount AS return_amount,
          0 AS sales_rows,
          1 AS return_rows
        FROM ci_fact_returns r
        LEFT JOIN ci_dim_customers c ON c.batch_id=r.batch_id AND c.client_key=r.client_key
        LEFT JOIN ci_dim_products p ON p.batch_id=r.batch_id AND p.product_key=r.product_key
        LEFT JOIN ci_dim_regions rg ON rg.batch_id=r.batch_id AND rg.state_key=r.state_key
        WHERE r.batch_id=?
      )
      GROUP BY month_key,state_key,regional_key,manager_key,representative_key,macro_key,group_key,channel,segment,brand`,
      batchId,
      batchId,
      batchId,
    ),
    stmt(
      e,
      "INSERT OR IGNORE INTO ci_dim_catalog(batch_id,dimension,value_key,display,extra) SELECT ?, 'state', state_key, COALESCE(state_name,state_key), regional_raw FROM ci_dim_regions WHERE batch_id=?",
      batchId,
      batchId,
    ),
    stmt(
      e,
      "INSERT OR IGNORE INTO ci_dim_catalog(batch_id,dimension,value_key,display,extra) SELECT DISTINCT ?, 'regional', regional_key, COALESCE(regional_raw,regional_key), manager_raw FROM ci_dim_regions WHERE batch_id=? AND regional_key IS NOT NULL",
      batchId,
      batchId,
    ),
    stmt(
      e,
      "INSERT OR IGNORE INTO ci_dim_catalog(batch_id,dimension,value_key,display,extra) SELECT DISTINCT ?, 'manager', manager_key, COALESCE(manager_raw,manager_key), NULL FROM ci_dim_regions WHERE batch_id=? AND manager_key IS NOT NULL",
      batchId,
      batchId,
    ),
    stmt(
      e,
      "INSERT OR IGNORE INTO ci_dim_catalog(batch_id,dimension,value_key,display,extra) SELECT DISTINCT ?, 'representative', representative_key, COALESCE(representative_raw,representative_key), NULL FROM ci_dim_customers WHERE batch_id=? AND representative_key IS NOT NULL",
      batchId,
      batchId,
    ),
    stmt(
      e,
      "INSERT OR IGNORE INTO ci_dim_catalog(batch_id,dimension,value_key,display,extra) SELECT DISTINCT ?, 'macro_category', macro_category_key, COALESCE(macro_category_raw,macro_category_key), NULL FROM ci_dim_products WHERE batch_id=? AND macro_category_key IS NOT NULL",
      batchId,
      batchId,
    ),
    stmt(
      e,
      "INSERT OR IGNORE INTO ci_dim_catalog(batch_id,dimension,value_key,display,extra) SELECT DISTINCT ?, 'group', group_key, COALESCE(group_raw,group_key), MAX(macro_key) FROM ci_fact_sales WHERE batch_id=? AND group_key IS NOT NULL GROUP BY group_key",
      batchId,
      batchId,
    ),
    stmt(
      e,
      "INSERT OR IGNORE INTO ci_dim_catalog(batch_id,dimension,value_key,display,extra) SELECT DISTINCT ?, 'channel', channel, channel, NULL FROM ci_fact_sales WHERE batch_id=? AND channel IS NOT NULL",
      batchId,
      batchId,
    ),
    stmt(
      e,
      "INSERT OR IGNORE INTO ci_dim_catalog(batch_id,dimension,value_key,display,extra) SELECT DISTINCT ?, 'segment', segment, segment, NULL FROM ci_dim_customers WHERE batch_id=? AND segment IS NOT NULL",
      batchId,
      batchId,
    ),
    stmt(
      e,
      "INSERT OR IGNORE INTO ci_dim_catalog(batch_id,dimension,value_key,display,extra) SELECT DISTINCT ?, 'brand', brand, brand, NULL FROM ci_dim_products WHERE batch_id=? AND brand IS NOT NULL",
      batchId,
      batchId,
    ),
  ]);
}

export async function computeBatchDiff(e: Env, batchId: string) {
  const active = await stmt(e, "SELECT active_batch_id FROM ci_csv_active WHERE id=1").first<{
    active_batch_id: string | null;
  }>();
  const prevId = active?.active_batch_id;
  if (!prevId || prevId === batchId) {
    return { baselineBatchId: null, initialLoad: true, added: {}, removed: {}, changed: {} };
  }

  const [newClients, removedClients, newProducts, removedProducts] = await Promise.all([
    stmt(
      e,
      "SELECT COUNT(*) AS n FROM ci_dim_customers n WHERE n.batch_id=? AND NOT EXISTS(SELECT 1 FROM ci_dim_customers p WHERE p.batch_id=? AND p.client_key=n.client_key)",
      batchId,
      prevId,
    ).first<{ n: number }>(),
    stmt(
      e,
      "SELECT COUNT(*) AS n FROM ci_dim_customers p WHERE p.batch_id=? AND NOT EXISTS(SELECT 1 FROM ci_dim_customers n WHERE n.batch_id=? AND n.client_key=p.client_key)",
      prevId,
      batchId,
    ).first<{ n: number }>(),
    stmt(
      e,
      "SELECT COUNT(*) AS n FROM ci_dim_products n WHERE n.batch_id=? AND NOT EXISTS(SELECT 1 FROM ci_dim_products p WHERE p.batch_id=? AND p.product_key=n.product_key)",
      batchId,
      prevId,
    ).first<{ n: number }>(),
    stmt(
      e,
      "SELECT COUNT(*) AS n FROM ci_dim_products p WHERE p.batch_id=? AND NOT EXISTS(SELECT 1 FROM ci_dim_products n WHERE n.batch_id=? AND n.product_key=p.product_key)",
      prevId,
      batchId,
    ).first<{ n: number }>(),
  ]);

  return {
    baselineBatchId: prevId,
    initialLoad: false,
    added: { customers: newClients?.n ?? 0, products: newProducts?.n ?? 0 },
    removed: { customers: removedClients?.n ?? 0, products: removedProducts?.n ?? 0 },
  };
}

export async function validateCsvBatch(e: Env, batchId: string) {
  const batch = await stmt(e, "SELECT * FROM ci_csv_batches WHERE id=?", batchId).first<CsvBatchRow>();
  if (!batch) fail(404, "Lote CSV não encontrado.");

  const summary = batch.summary_json ? (JSON.parse(batch.summary_json) as { customerConflicts?: string[] }) : {};
  const [salesAgg, retAgg, calDates, orphanClients, orphanProducts, orphanStates, docStats] =
    await Promise.all([
      stmt(
        e,
        "SELECT COUNT(*) AS rows, COALESCE(SUM(gross_amount),0) AS gross, COUNT(DISTINCT client_key) AS buyers FROM ci_fact_sales WHERE batch_id=?",
        batchId,
      ).first<{ rows: number; gross: number; buyers: number }>(),
      stmt(
        e,
        "SELECT COUNT(*) AS rows, COALESCE(SUM(return_amount),0) AS returns FROM ci_fact_returns WHERE batch_id=?",
        batchId,
      ).first<{ rows: number; returns: number }>(),
      stmt(
        e,
        "SELECT (SELECT COUNT(*) FROM ci_dim_calendar WHERE batch_id=?) AS cal_days, (SELECT COUNT(*) FROM ci_fact_sales s WHERE s.batch_id=? AND NOT EXISTS(SELECT 1 FROM ci_dim_calendar d WHERE d.batch_id=s.batch_id AND d.date=s.date)) AS outside_cal",
        batchId,
        batchId,
      ).first<{ cal_days: number; outside_cal: number }>(),
      stmt(
        e,
        "SELECT COUNT(DISTINCT client_key) AS n FROM ci_fact_sales s WHERE s.batch_id=? AND s.client_key IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ci_dim_customers c WHERE c.batch_id=s.batch_id AND c.client_key=s.client_key)",
        batchId,
      ).first<{ n: number }>(),
      stmt(
        e,
        "SELECT COUNT(DISTINCT product_key) AS n FROM ci_fact_sales s WHERE s.batch_id=? AND s.product_key IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ci_dim_products p WHERE p.batch_id=s.batch_id AND p.product_key=s.product_key)",
        batchId,
      ).first<{ n: number }>(),
      stmt(
        e,
        "SELECT COUNT(DISTINCT state_key) AS n FROM ci_fact_sales s WHERE s.batch_id=? AND s.state_key IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ci_dim_regions r WHERE r.batch_id=s.batch_id AND r.state_key=s.state_key)",
        batchId,
      ).first<{ n: number }>(),
      stmt(
        e,
        "SELECT COUNT(DISTINCT doc_no) AS docs FROM ci_fact_sales WHERE batch_id=? AND doc_no IS NOT NULL AND doc_no<>''",
        batchId,
      ).first<{ docs: number }>(),
    ]);

  const gross = (salesAgg?.gross ?? 0) / 10 ** MONETARY_SCALE;
  const returns = (retAgg?.returns ?? 0) / 10 ** MONETARY_SCALE;
  const net = gross - returns;
  const buyers = salesAgg?.buyers ?? 0;
  const docs = docStats?.docs ?? 0;

  const checks = [
    {
      name: "fatos_carregados",
      status: (salesAgg?.rows ?? 0) > 0 ? "passed" : "failed",
      detail: `${salesAgg?.rows ?? 0} linhas de faturamento e ${retAgg?.rows ?? 0} devoluções estruturadas.`,
    },
    {
      name: "deduplicacao_clientes",
      status: (summary.customerConflicts?.length ?? 0) === 0 ? "passed" : "warning",
      detail:
        (summary.customerConflicts?.length ?? 0) === 0
          ? "Base Clientes deduplicada sem conflitos de atributos."
          : `${summary.customerConflicts?.length} conflitos de atributo detectados na deduplicação.`,
    },
    {
      name: "cobertura_calendario",
      status: !calDates?.cal_days || calDates.outside_cal === 0 ? "passed" : "failed",
      detail: calDates?.cal_days
        ? `${calDates.outside_cal} registros fora de dCalendario.`
        : "dCalendario não anexado neste lote; verificação ignorada.",
    },
    {
      name: "chaves_referencias",
      status:
        (orphanClients?.n ?? 0) === 0 && (orphanProducts?.n ?? 0) === 0 && (orphanStates?.n ?? 0) === 0
          ? "passed"
          : "warning",
      detail: `Chaves sem cadastro correspondente (preservadas no estilo M:M): ${orphanClients?.n ?? 0} clientes, ${orphanProducts?.n ?? 0} produtos, ${orphanStates?.n ?? 0} UFs.`,
    },
  ];

  const failed = checks.some((c) => c.status === "failed");
  const validation = {
    passed: !failed,
    checks,
    reconciliation: {
      grossRevenue: gross,
      returns,
      netRevenue: net,
      distinctBuyers: buyers,
      distinctInvoices: docs,
      ticketPerBuyer: buyers > 0 ? net / buyers : null,
      ticketPerInvoice: docs > 0 ? net / docs : null,
      salesRows: salesAgg?.rows ?? 0,
      returnRows: retAgg?.rows ?? 0,
    },
  };

  await stmt(
    e,
    "UPDATE ci_csv_batches SET status=?,validation_json=?,error=?,updated=? WHERE id=?",
    failed ? "failed" : "validated",
    JSON.stringify(validation),
    failed ? "Falha nas verificações de validação do lote CSV." : null,
    now(),
    batchId,
  ).run();

  return validation;
}

export async function csvAdminRoute(req: Request, e: Env, u: DbUser, path: string): Promise<Response | null> {
  if (!path.startsWith("/admin/csv")) return null;
  if (u.role !== "admin" && u.role !== "operador") {
    fail(403, "Acesso exclusivo da administração ou operação de atualização.");
  }

  const method = req.method;
  try {
    if (path === "/admin/csv/batches" && method === "GET") {
      const [batches, active] = await Promise.all([
        stmt(e, "SELECT * FROM ci_csv_batches ORDER BY created DESC LIMIT 30").all<CsvBatchRow>(),
        stmt(e, "SELECT * FROM ci_csv_active WHERE id=1").first<ActiveCsvRow>(),
      ]);
      return json({
        migrated: true,
        mode: active?.mode ?? "shadow",
        activeBatchId: active?.active_batch_id ?? null,
        previousBatchId: active?.previous_batch_id ?? null,
        schemas: CSV_SCHEMAS,
        batches: batches.results,
      });
    }

    if (path === "/admin/csv/batches" && method === "POST") {
      const input = z
        .object({
          sourceLabel: z.string().trim().min(2).max(120),
          referenceDate: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
        })
        .strict()
        .parse(await body(req));
      const id = crypto.randomUUID();
      const ts = now();
      await e.DB.batch([
        stmt(
          e,
          "INSERT INTO ci_csv_batches(id,actor,owner,status,source_label,reference_date,created,updated) VALUES(?,?,?,?,?,?,?,?)",
          id,
          u.name,
          u.id,
          "staging",
          input.sourceLabel,
          input.referenceDate ?? null,
          ts,
          ts,
        ),
        audit(e, u.id, "csv_lote_criado", id),
      ]);
      return json({ id, status: "staging", sourceLabel: input.sourceLabel }, 201);
    }

    const fileMatch = path.match(/^\/admin\/csv\/batches\/([a-f0-9-]{36})\/files\/([a-z_]+)$/);
    if (fileMatch && method === "PUT") {
      const [, batchId, roleRaw] = fileMatch;
      if (!csvRoles.includes(roleRaw as CsvRole)) fail(400, "Papel de arquivo CSV inválido.");
      const role = roleRaw as CsvRole;
      const batch = await stmt(e, "SELECT * FROM ci_csv_batches WHERE id=?", batchId).first<CsvBatchRow>();
      if (!batch) fail(404, "Lote CSV não encontrado.");
      if (batch.status === "active") fail(409, "Lote ativo é imutável; crie um novo lote.");

      const bucket = (e as CsvEnv).BUCKET;
      if (!bucket) fail(503, "O armazenamento R2 dos arquivos CSV não está configurado.");
      const maxBytes = Number((e as CsvEnv).CSV_MAX_FILE_BYTES) || DEFAULT_MAX_CSV_BYTES;
      const bytesBuf = new Uint8Array(await req.arrayBuffer());
      if (!bytesBuf.byteLength || bytesBuf.byteLength > maxBytes) {
        fail(413, "Arquivo vazio ou acima do limite permitido.");
      }
      const sha256 = createHash("sha256").update(bytesBuf).digest("hex");
      const filename =
        (req.headers.get("x-filename") || CSV_SCHEMAS[role].defaultFilename).slice(0, 180);
      const objectKey = `${CSV_PREFIX}${batchId}/${role}.csv`;
      const r2WithPut = bucket as R2Bucket & { put?: R2Bucket["put"] };
      if (typeof r2WithPut.put === "function") {
        await r2WithPut.put(objectKey, bytesBuf, {
          httpMetadata: { contentType: "text/csv; charset=utf-8" },
          customMetadata: { batchId, role, sha256 },
        });
      } else {
        const multipart = await bucket.createMultipartUpload(objectKey, {
          httpMetadata: { contentType: "text/csv; charset=utf-8" },
          customMetadata: { batchId, role, sha256 },
        });
        const part = await multipart.uploadPart(
          1,
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytesBuf);
              controller.close();
            },
          }),
        );
        await multipart.complete([part]);
      }
      await stmt(
        e,
        `INSERT INTO ci_csv_files(batch_id,role,filename,sha256,bytes,object_key,status,updated)
         VALUES(?,?,?,?,?,?,'staged',?)
         ON CONFLICT(batch_id,role) DO UPDATE SET filename=excluded.filename,sha256=excluded.sha256,bytes=excluded.bytes,object_key=excluded.object_key,status='staged',updated=excluded.updated`,
        batchId,
        role,
        filename,
        sha256,
        bytesBuf.byteLength,
        objectKey,
        now(),
      ).run();
      return json({ batchId, role, filename, sha256, bytes: bytesBuf.byteLength, status: "staged" });
    }

    const actionMatch = path.match(
      /^\/admin\/csv\/batches\/([a-f0-9-]{36})\/(process|validate|activate)$/,
    );
    if (actionMatch && method === "POST") {
      const [, batchId, action] = actionMatch;
      if (action === "process") return json(await processCsvBatch(e, batchId));
      if (action === "validate") return json(await validateCsvBatch(e, batchId));
      if (action === "activate") {
        if (u.role !== "admin") fail(403, "Somente o administrador pode ativar um lote CSV.");
        const batch = await stmt(e, "SELECT * FROM ci_csv_batches WHERE id=?", batchId).first<CsvBatchRow>();
        if (!batch) fail(404, "Lote CSV não encontrado.");
        if (batch.status !== "validated" && batch.status !== "active") {
          fail(409, "O lote precisa passar pela validação antes de ser ativado.");
        }
        const active = await stmt(e, "SELECT * FROM ci_csv_active WHERE id=1").first<ActiveCsvRow>();
        const ts = now();
        await e.DB.batch([
          stmt(
            e,
            "UPDATE ci_csv_batches SET status='validated',updated=? WHERE status='active' AND id<>?",
            ts,
            batchId,
          ),
          stmt(
            e,
            "UPDATE ci_csv_batches SET status='active',activated_at=?,updated=? WHERE id=?",
            ts,
            ts,
            batchId,
          ),
          stmt(
            e,
            "UPDATE ci_csv_active SET previous_batch_id=?,active_batch_id=?,mode='active',updated=?,actor=? WHERE id=1",
            active?.active_batch_id && active.active_batch_id !== batchId
              ? active.active_batch_id
              : active?.previous_batch_id ?? null,
            batchId,
            ts,
            u.name,
          ),
          audit(e, u.id, "csv_lote_ativado", batchId),
        ]);
        return json({ ok: true, mode: "active", activeBatchId: batchId });
      }
    }

    if (path === "/admin/csv/rollback" && method === "POST") {
      if (u.role !== "admin") fail(403, "Somente o administrador pode reverter o lote CSV ativo.");
      const active = await stmt(e, "SELECT * FROM ci_csv_active WHERE id=1").first<ActiveCsvRow>();
      if (!active?.active_batch_id) fail(409, "Nenhum lote CSV ativo para reverter.");
      const ts = now();
      const target = active.previous_batch_id;
      await e.DB.batch([
        stmt(
          e,
          "UPDATE ci_csv_batches SET status='rolled_back',updated=? WHERE id=?",
          ts,
          active.active_batch_id,
        ),
        ...(target
          ? [stmt(e, "UPDATE ci_csv_batches SET status='active',updated=? WHERE id=?", ts, target)]
          : []),
        stmt(
          e,
          "UPDATE ci_csv_active SET active_batch_id=?,previous_batch_id=NULL,mode=?,updated=?,actor=? WHERE id=1",
          target,
          target ? "active" : "shadow",
          ts,
          u.name,
        ),
        audit(e, u.id, "csv_lote_revertido", target ?? "shadow"),
      ]);
      return json({
        ok: true,
        mode: target ? "active" : "shadow",
        activeBatchId: target,
      });
    }
  } catch (err) {
    if (isMissingCsvSchemaError(err)) {
      fail(503, "A migração da camada CSV estruturada (0011) ainda não foi aplicada.");
    }
    throw err;
  }

  return null;
}
