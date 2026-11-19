/** Remote integration acceptance. The only allowed remote is the isolated HML Worker.
 * Usage: node --import tsx scripts/hml-verify.ts .wrangler/hml/access.json
 * access.json: { origin, admin: { email, password } }. Never commit this file.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { syntheticHmlPackage } from "./hml-fixture";
import type { Plan, Report, Role, Session, User } from "../shared/domain";
import type { AssistantStatus, VisitBriefing } from "../shared/commercial";

const origin = "https://commercial-insight-hml.araujo-anderson26.workers.dev";
const privateRoot = resolve(".wrangler/hml");
function privatePath(value: string) {
  const path = resolve(value), rel = relative(privateRoot, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw Error("Use a private file inside .wrangler/hml.");
  return path;
}
const accessPath = privatePath(process.argv[2] ?? ".wrangler/hml/access.json");
const access = JSON.parse(readFileSync(accessPath, "utf8")) as { origin: string; admin: { email: string; password: string }; users?: unknown };
if (new URL(access.origin).origin !== origin || access.origin !== origin) throw Error("Only the isolated homologation origin is allowed.");
if (typeof access.admin?.email !== "string" || typeof access.admin?.password !== "string") throw Error("A new synthetic homologation administrator is required.");
const reportPath = privatePath(process.argv[3] ?? ".wrangler/hml/api-verification.json");
const runId = randomUUID(), accounts = new Map<string, Account>();
type Account = { email: string; password: string; cookie?: string; id?: string; user?: Omit<User, "id"> };
type ImportState = { id: string; status: string; partBytes: number; existing?: boolean; report?: { controls?: { passed: boolean }[]; checks?: { name: string; status: string }[] }; error?: string };
type Check = { name: string; passed: boolean; detail?: string };
const report = { runId, origin, synthetic: true, startedAt: new Date().toISOString(), completedAt: "", ok: false,
  requests: 0, uploadedBytes: 0, downloadedBytes: 0, checks: [] as Check[], imports: [] as { id: string; status: string; synthetic: true }[], failures: [] as string[] };
const admin: Account = { ...access.admin }; accounts.set("admin", admin);
let operation = "bootstrap";
const flush = () => { mkdirSync(dirname(reportPath), { recursive: true }); writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 }); };
function checked(name: string, detail?: string) { report.checks.push({ name, passed: true, ...(detail ? { detail } : {}) }); flush(); process.stdout.write(JSON.stringify({ check: name, passed: true }) + "\n"); }
async function api<T>(path: string, method = "GET", value?: unknown, actor: Account | null = admin, expected = [200]): Promise<{ data: T; response: Response }> {
  if (!/^[a-z0-9/_-]+$/i.test(path) || path.includes("//")) throw Error("Invalid API test path.");
  operation = method + " " + path;
  const raw = value instanceof Uint8Array;
  const payload = value === undefined ? undefined : raw ? Buffer.from(value) : JSON.stringify(value);
  const headers: Record<string, string> = { Origin: origin, "Content-Type": raw ? "application/octet-stream" : "application/json" };
  if (actor?.cookie) headers.Cookie = actor.cookie;
  if (raw) headers["Content-Length"] = String((payload as Buffer).length);
  report.requests++;
  const response = await fetch(origin + "/api/" + path, { method, headers, body: payload, redirect: "error", signal: AbortSignal.timeout(60000) });
  const responseText = await response.text(); report.downloadedBytes += Buffer.byteLength(responseText);
  assert.ok(expected.includes(response.status), `${method} ${path}: expected ${expected.join("/")}, received ${response.status}`);
  if (response.status === 200 && path !== "auth/login") assert.match(response.headers.get("cache-control") ?? "", /no-store/i);
  return { data: (responseText ? JSON.parse(responseText) : null) as T, response };
}
async function login(actor: Account) {
  const { response } = await api("auth/login", "POST", { email: actor.email, password: actor.password }, null);
  const cookie = response.headers.get("set-cookie"); assert.ok(cookie,"Session cookie is missing"); assert.ok(cookie.includes("HttpOnly"),"Session cookie must use HttpOnly"); assert.ok(cookie.includes("Secure"),"Session cookie must use Secure");
  actor.cookie = cookie.split(";")[0];
  const { data } = await api<Session>("me", "GET", undefined, actor); actor.id = data.user.id; return data;
}
async function createAccount(key: string, role: Role, clients: string[], regions: string[] = [], national = false) {
  const suffix = runId.slice(0, 8);
  const actor: Account = { email: `${key}-${suffix}@hml.example.test`, password: randomBytes(30).toString("base64url"),
    user: { name: `SINTÉTICO HML ${key} ${suffix}`, email: `${key}-${suffix}@hml.example.test`, role, national, active: true, regions, clients, entraOid: null } };
  const { data } = await api<{ id: string }>("admin/users", "POST", { user: actor.user, password: actor.password });
  actor.id = data.id; accounts.set(key, actor); await login(actor); return actor;
}
async function importPackage(pkg: ReturnType<typeof syntheticHmlPackage>, actor: Account, filename: string) {
  assert.equal(pkg.manifest.synthetic, true);
  const { data: upload } = await api<ImportState>("admin/data/imports", "POST", { filename, bytes: pkg.data.length, sha256: pkg.sha256 }, actor, [200, 201]);
  if (!["published", "failed"].includes(upload.status)) {
    assert.ok(upload.partBytes >= pkg.data.length, "Synthetic package should fit in one upload part.");
    await api(`admin/data/imports/${upload.id}/parts/1`, "PUT", pkg.data, actor); report.uploadedBytes += pkg.data.length;
    await api(`admin/data/imports/${upload.id}/complete`, "POST", {}, actor);
  }
  const began = Date.now(); let last = upload;
  while (!['published', 'failed', 'cancelled', 'superseded'].includes(last.status)) {
    if (Date.now() - began > 360000) throw Error("Import did not finish within six minutes.");
    await pause(2500);
    last = (await api<ImportState>(`admin/data/imports/${upload.id}`, "GET", undefined, actor)).data;
  }
  report.imports.push({ id: last.id, status: last.status, synthetic: true }); flush(); return last;
}
const filters = { from: "2026-01", to: "2026-01", region: "", client: "", product: "" };
const plan: Plan = { metric: "revenue", group: "month", order: "current", filters };
const current = (result: Report, metric: keyof Report["total"]["values"]) => result.total.values[metric].current;

try {
  await api("me", "GET", undefined, null, [401]); checked("anonymous API requires login");
  const me = await login(admin); assert.equal(me.user.role, "admin"); checked("new HML administrator login and private session cookie");
  const { data: config } = await api<{ secrets: Record<string, boolean> }>("admin/config");
  assert.equal(config.secrets.openai, false, "Do not reuse an OpenAI credential in HML.");
  assert.equal(config.secrets.microsoft, false); assert.equal(config.secrets.encryption, false); checked("HML does not inherit production integration credentials");
  await api("admin/data/settings", "PUT", { source: "manual", staleDays: 7, allowAI: false });
  const sales = await createAccount("sales", "comercial", ["0001"]);
  const other = await createAccount("other", "comercial", ["0002"]);
  const manager = await createAccount("manager", "gerente", ["0001"], ["Rep A"]);
  const executive = await createAccount("executive", "diretoria", [], [], true);
  const operator = await createAccount("operator", "operador", []);
  const noScope = await createAccount("no-scope", "comercial", []);
  writeFileSync(accessPath, JSON.stringify({ ...access, users: Object.fromEntries([...accounts].filter(([key]) => key !== "admin").map(([key, actor]) => [key, { email: actor.email, password: actor.password, id: actor.id, user: actor.user }])) }, null, 2) + "\n", { mode: 0o600 });
  checked("synthetic sales, manager, executive, operator and no-scope profiles created");
  const valid = syntheticHmlPackage();
  writeFileSync(privatePath(".wrangler/hml/SINTETICO-valid.ci.ndjson"), valid.data, { mode: 0o600 });
  const published = await importPackage(valid, operator, "SINTETICO-hml-valid.ci.ndjson");
  assert.equal(published.status, "published"); assert.equal(published.report?.controls?.length, 36); assert.equal(published.report?.controls?.every(control => control.passed), true);
  checked("native synthetic upload, durable processing and all 36 reconciliation controls publish");
  const { data: initialState } = await api<{ active: { id: string } }>("data/status"); assert.equal(initialState.active.id, published.id);
  const { data: national } = await api<Report>("report", "POST", plan);
  assert.deepEqual([current(national,"gross"), current(national,"returns"), current(national,"revenue"), current(national,"buyers")], [350,1034,-684,2]);
  assert.equal(national.total.values.revenue.previous,90); assert.equal(national.sourceInfo?.versionId,published.id);
  for (const group of ["client","product","category","region","regional","state","manager"] as const) {
    const { data: grouped } = await api<Report>("report","POST",{...plan,group});
    assert.equal(current(grouped,"revenue"),-684); assert.ok(grouped.rows.length>0); assert.equal(grouped.sourceInfo?.versionId,published.id);
    if (group === "client") assert.ok(grouped.rows.some(row => row.name.includes("Cliente SINTÉTICO")));
    if (group === "product") assert.ok(grouped.rows.some(row => row.name.includes("Produto SINTÉTICO")));
  }
  checked("executive dashboard metrics and all eight report groupings match synthetic expectations");
  for (const actor of [sales,manager]) {
    const { data: scoped } = await api<Report>("report","POST",plan,actor); assert.equal(current(scoped,"revenue"),135); assert.equal(scoped.total.values.revenue.previous,90);
    await api("report","POST",{...plan,filters:{...filters,client:"0002"}},actor,[403]);
  }
  const { data: consolidated } = await api<Report>("report","POST",plan,executive); assert.equal(current(consolidated,"revenue"),-684);
  await api("report","POST",plan,noScope,[403]);
  await api("admin/users","GET",undefined,sales,[403]);
  const { data: search } = await api<{items:{key:string;name:string}[]}>("data/search","POST",{filters,dimension:"client",query:"Cliente SINTÉTICO"},sales);
  assert.deepEqual(search.items.map(item=>item.key),["0001"]); checked("sales and manager ACL, national authorization and scoped description search");
  const { data: visit } = await api<VisitBriefing>("visit","POST",{...filters,client:"0001"},sales);
  assert.equal(visit.client.code,"0001"); assert.equal(current(visit.timeline,"revenue"),135); assert.equal(visit.timeline.total.values.revenue.previous,90);
  assert.equal(visit.activity.lastPurchase,"2026-01-02"); assert.equal(visit.activity.purchaseDays,2); assert.ok(visit.products.rows.some(row=>row.name.includes("Produto SINTÉTICO")));
  await api("visit","POST",{...filters,client:"0002"},sales,[403]); checked("visit briefing matches authorized financial, product and daily activity evidence");
  const { data: favorite } = await api<{id:string}>("saved-reports","POST",{title:"SINTÉTICO HML carteira",plan},sales,[201]);
  const { data: ownSaved } = await api<{id:string}[]>("saved-reports","GET",undefined,sales); assert.ok(ownSaved.some(item=>item.id===favorite.id));
  assert.deepEqual((await api("saved-reports","GET",undefined,other)).data,[]);
  await api(`saved-reports/${favorite.id}`,"DELETE",undefined,other,[404]);
  await api(`saved-reports/${favorite.id}`,"DELETE",undefined,sales); checked("saved reports isolate owner and reauthorize queries");
  for (const [path,method,value] of [["report","POST",plan],["visit","POST",{...filters,client:"0001"}],["admin/users","GET",undefined],["admin/data/settings","PUT",{source:"manual",allowAI:true,staleDays:7}],["admin/data/restore","POST",{versionId:published.id,expectedActiveVersionId:published.id}],[`admin/data/imports/${published.id}/package`,"GET",undefined]] as const) await api(path,method,value,operator,[403]);
  checked("update operator cannot analyze, administer, restore or download raw data");
  const { data: ai } = await api<AssistantStatus>("assistant/status"); assert.equal(ai.ready,false); assert.deepEqual(ai.pending,["source_disabled","credential_missing"]);
  await api("chat","POST",{question:"Como está meu resultado comercial?",filters,conversation:null},sales,[409]); checked("OpenAI remains disabled without a credential and no model call is authorized");
  const invalid = syntheticHmlPackage(true); writeFileSync(privatePath(".wrangler/hml/SINTETICO-invalid.ci.ndjson"),invalid.data,{mode:0o600});
  const rejected = await importPackage(invalid,admin,"SINTETICO-hml-invalid-kpi.ci.ndjson"); assert.equal(rejected.status,"failed");
  const { data: finalState } = await api<{active:{id:string}}>("data/status"); assert.equal(finalState.active.id,published.id);
  const { data: afterFailure } = await api<Report>("report","POST",plan); assert.equal(current(afterFailure,"revenue"),-684);
  checked("divergent KPI package is rejected and cannot replace the validated active snapshot");
  // Keep the synthetic accounts and two import evidence records for the user's review, but close every automated session.
  report.ok=true;
} catch (error) {
  // Assertion/provider messages can contain header values. Only the operation and error type are recorded.
  report.failures.push(`${operation}: ${error instanceof Error ? error.name : "verification_failed"}`); process.exitCode=1;
} finally {
  for (const actor of accounts.values()) if (actor.cookie) {
    try { await api("auth/logout","POST",{},actor); actor.cookie=undefined; }
    catch { report.failures.push("session_cleanup_failed"); report.ok=false; process.exitCode=1; }
  }
  report.completedAt=new Date().toISOString(); flush();
  process.stdout.write(JSON.stringify({ok:report.ok,checks:report.checks.length,requests:report.requests,uploadedBytes:report.uploadedBytes,privateReport:relative(resolve(),reportPath),failures:report.failures})+"\n");
}
