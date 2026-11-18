import { execFileSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse } from "jsonc-parser";

// Opt-in, read-only HTTP probe using a short-lived session for an existing admin.
// No passwords, permission changes, commercial uploads or session tokens are logged.
if (!process.argv.includes("--remote")) throw Error("Use --remote explicitly after verifying wrangler.jsonc.");
const cfg = parse(readFileSync("wrangler.jsonc", "utf8"));
const origin = new URL(cfg.vars.APP_ORIGIN).origin;
if (!origin.startsWith("https://")) throw Error("Production probe requires HTTPS.");
function query(sql) {
  const text = execFileSync(process.execPath,
    ["node_modules/wrangler/bin/wrangler.js", "d1", "execute", "DB", "--remote", "--json", "--command", sql],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(text)[0].results;
}
const existing = query("SELECT id,version FROM users WHERE role='admin' AND active=1 LIMIT 1")[0];
if (!existing || !/^[a-f0-9-]{36}$/.test(existing.id)) throw Error("No existing administrator available for the probe.");
const session = randomBytes(32).toString("hex");
const hash = createHash("sha256").update(session).digest("hex");
const now = Math.floor(Date.now() / 1000);
try {
  query(`INSERT INTO sessions(hash,user_id,version,expires,seen) VALUES('${hash}','${existing.id}',${Number(existing.version)},${now + 180},${now})`);
  async function authenticated(path) {
    const response = await fetch(origin + path, { headers: { Cookie: "__Host-ci=" + session }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw Error("Authenticated production probe failed: " + path + " HTTP " + response.status);
    if (!response.headers.get("cache-control")?.includes("no-store")) throw Error("Private response is missing no-store: " + path);
    return response.json();
  }
  const me = await authenticated("/api/me");
  const data = await authenticated("/api/admin/data");
  const config = await authenticated("/api/admin/config");
  if (me.user.role !== "admin" || !me.data || !Array.isArray(data.history)) throw Error("Unexpected deployed API contract.");
  const unauthenticated = await fetch(origin + "/api/admin/data");
  if (unauthenticated.status !== 401) throw Error("Administration must require authentication.");
  for (const path of ["/admin/atualizacao-dados", "/atualizacao-dados.md", "/preparador-comercial-insight.zip"]) {
    const response = await fetch(origin + path, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw Error("Missing deployed artifact " + path);
    const type = response.headers.get("content-type") || "";
    if (path.endsWith(".zip") && type.includes("text/html")) throw Error("Preparer returned SPA fallback instead of ZIP.");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (path.endsWith(".zip") && createHash("sha256").update(bytes).digest("hex") !==
      createHash("sha256").update(readFileSync("dist/preparador-comercial-insight.zip")).digest("hex"))
      throw Error("Deployed preparer differs from the verified local artifact.");
  }
  console.log(JSON.stringify({ authenticatedAdminAPI: true, unauthenticatedAdminStatus: 401,
    source: data.source, activeVersion: data.active?.id ?? null, imports: data.history.length,
    preparerDownload: true, instructions: true, openAIConfigured: config.secrets.openai }));
} finally {
  query(`DELETE FROM sessions WHERE hash='${hash}'`);
}
