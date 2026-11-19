/** Read-only reconciliation against the Power BI controls carried in an existing native package.
 * Usage: node --import tsx scripts/reconcile-snapshot.ts package.ci.ndjson snapshot.sqlite version-id [report.json]
 * Output contains counts and hashes only. Reports must remain in ignored .wrangler storage.
 */
import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { decimalInteger, manifestSchema } from "../shared/manual";
import { nativeControlResult, nativeValues, validateNativeModel, validateNativeStorage, type NativeResult } from "../worker/native-model";
import type { Env } from "../worker/core";

const [packageArg, databaseArg, versionArg, reportArg] = process.argv.slice(2);
if (!packageArg || !databaseArg || !versionArg) {
  process.stderr.write("Use: node --import tsx scripts/reconcile-snapshot.ts package.ci.ndjson snapshot.sqlite version-id [report.json]\n");
  process.exitCode = 1;
} else {
  const reportPath = resolve(reportArg ?? ".wrangler/reconciliation/snapshot-" + Date.now() + ".json");
  const privateRoot = resolve(".wrangler"), reportRelative = relative(privateRoot, reportPath);
  if (!reportRelative || reportRelative.startsWith("..") || isAbsolute(reportRelative)) throw Error("O relatório deve permanecer dentro de .wrangler.");
  if (reportPath === resolve(packageArg) || reportPath === resolve(databaseArg)) throw Error("O relatório não pode substituir a fonte de evidência.");
  const input = createReadStream(resolve(packageArg)), lines = createInterface({ input, crlfDelay: Infinity });
  let firstLine = "";
  for await (const line of lines) { firstLine = line.replace(/^\uFEFF/, ""); lines.close(); input.destroy(); break; }
  const manifest = manifestSchema.parse(JSON.parse(firstLine));
  if (manifest.synthetic || manifest.formatVersion !== 2) throw Error("A conciliação oficial exige pacote nativo v2 não sintético.");
  validateNativeModel(manifest);
  const database = new DatabaseSync(resolve(databaseArg), { readOnly: true });
  const report: {
    generatedAt: string; manifestSha256: string; readOnly: true; tableCountsPassed: boolean;
    controls: { index: number; metric: string; context: string; passed: boolean }[];
    completed: boolean; error?: string;
  } = { generatedAt: new Date().toISOString(), manifestSha256: createHash("sha256").update(firstLine).digest("hex"), readOnly: true, tableCountsPassed: false, controls: [], completed: false };
  class Statement {
    constructor(readonly sql: string, readonly args: (string | number | null)[] = []) {}
    bind(...args: (string | number | null)[]) { return new Statement(this.sql, args); }
    async all() { return { results: database.prepare(this.sql).all(...this.args) }; }
    async first() { return database.prepare(this.sql).get(...this.args) ?? null; }
  }
  const env = { DB: { prepare: (sql: string) => new Statement(sql) } } as unknown as Env;
  try {
    if (!database.prepare("SELECT 1 FROM ci_imports WHERE id=?").get(versionArg)) throw Error("snapshot_missing");
    await validateNativeStorage(env, manifest, versionArg);
    for (const table of manifest.inventory.tables) {
      const count = database.prepare("SELECT COUNT(*) AS n FROM ci_raw_rows WHERE version_id=? AND table_id=?").get(versionArg, table.id);
      if (Number(count?.n) !== table.rowCount) throw Error("raw_row_count_mismatch");
    }
    report.tableCountsPassed = true;
    const cache = new Map<string, NativeResult>();
    for (const [index, control] of manifest.controls.entries()) {
      const metric = manifest.metrics.find(item => item.id === control.metric);
      if (!metric || metric.status !== "validated") throw Error("control_metric_unavailable");
      const key = JSON.stringify(Object.entries(control.filters).sort(([a], [b]) => a.localeCompare(b)));
      let row = cache.get(key);
      if (!row) { row = (await nativeValues(env, versionArg, [control.filters]))[0]; cache.set(key, row); }
      const observed = nativeControlResult(manifest, row, control.metric);
      let passed = observed.value === null && control.expected === null;
      if (observed.value !== null && control.expected !== null) {
        if (control.metric === "buyers") passed = observed.value === Number(control.expected);
        else {
          const difference = BigInt(observed.raw!) - BigInt(decimalInteger(control.expected, metric.scale));
          passed = (difference < 0n ? -difference : difference) <= BigInt(decimalInteger(control.tolerance, metric.scale));
        }
      }
      report.controls.push({ index, metric: control.metric, context: control.context, passed });
      if (report.controls.length % 40 === 0) process.stdout.write(JSON.stringify({ completedControls: report.controls.length }) + "\n");
    }
    report.completed = true;
  } catch (error) {
    report.error = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "reconciliation_failed";
    process.exitCode = 1;
  } finally {
    database.close(); mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
  const passed = report.controls.filter(control => control.passed).length;
  const ok = report.completed && report.tableCountsPassed && passed === manifest.controls.length;
  if (!ok) process.exitCode = 1;
  process.stdout.write(JSON.stringify({ ok, readOnly: true, controls: report.controls.length, passed, failed: report.controls.length - passed, manifestSha256: report.manifestSha256, report: relative(resolve(), reportPath) }) + "\n");
}
