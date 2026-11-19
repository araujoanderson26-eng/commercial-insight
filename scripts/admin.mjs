import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { passwordHash } from "../shared/password.mjs";
const [email, name, mode, configFlag, configPath] = process.argv.slice(2);
const targetArgs = configFlag === "--config" && configPath ? ["--config", configPath] : [];
if (
  !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || "") ||
  !name ||
  !["--local", "--remote"].includes(mode) ||
  (configFlag !== undefined && (configFlag !== "--config" || !configPath))
) {
  console.error('Uso: npm run admin -- email "Nome" --local|--remote [--config wrangler.hml.jsonc]');
  process.exit(1);
}
const dir = mkdtempSync(join(tmpdir(), "ci-init-"));
const password = randomBytes(22).toString("base64url");
const quote = (s) => "'" + s.replaceAll("'", "''") + "'";
try {
  const id = randomUUID();
  const sql =
    "INSERT INTO users(id,email,name,password,role,national,created) SELECT " +
    [id, email.toLowerCase(), name, await passwordHash(password), "admin"].map(quote).join(",") +
    ",1,unixepoch() WHERE NOT EXISTS (SELECT 1 FROM users);";
  const file = join(dir, "admin.sql");
  writeFileSync(file, sql, { mode: 0o600 });
  const pkg = JSON.parse(readFileSync("node_modules/wrangler/package.json", "utf8"));
  const result = spawnSync(
    process.execPath,
    [
      resolve("node_modules/wrangler", pkg.bin.wrangler),
      "d1",
      "execute",
      "DB",
      mode,
      ...targetArgs,
      "--file",
      file,
      "--json",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw Error(result.stderr || "Falha ao aplicar o cadastro.");
  const check = spawnSync(
    process.execPath,
    [
      resolve("node_modules/wrangler", pkg.bin.wrangler),
      "d1",
      "execute",
      "DB",
      mode,
      ...targetArgs,
      "--command",
      "SELECT id FROM users WHERE id=" + quote(id),
      "--json",
    ],
    { encoding: "utf8" },
  );
  const rows = check.status === 0 ? JSON.parse(check.stdout) : [];
  if (!rows.some((r) => r.results?.some((row) => row.id === id)))
    throw Error(
      "Base já inicializada ou inclusão não confirmada. Confira os usuários antes de tentar novamente.",
    );
  console.log(
    "Administrador inicial: " +
      email +
      "\nSenha inicial (exibida uma vez): " +
      password +
      "\nAltere a senha em Meu perfil.",
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
