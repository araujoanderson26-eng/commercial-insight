import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fixturePackage } from "./manual-fixtures";

const sdk = process.env.CI_DOTNET || join(process.env.LOCALAPPDATA || "", "Temp", "ci10sdk", "dotnet.exe");
const available = process.platform === "win32" && existsSync(sdk);
const skip = available ? false : "Requer Windows e SDK .NET 10; defina CI_DOTNET para executar os testes do preparador.";
let executable: string | undefined;
function compiled() {
  if (executable) return executable;
  const cliHome = resolve(".wrangler/dotnet-cli"); mkdirSync(cliHome, { recursive: true });
  execFileSync(sdk, ["build", "tools/preparador/ComercialInsight.Preparador.csproj", "-c", "Release", "--no-restore"], {
    windowsHide: true, encoding: "utf8", timeout: 120000,
    env: { ...process.env, DOTNET_CLI_HOME: cliHome, DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1", DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_GENERATE_ASPNET_CERTIFICATE: "false" },
  });
  executable = resolve("tools/preparador/bin/Release/net10.0-windows/win-x64/ComercialInsight.Preparador.exe");
  return executable;
}
function run(args: string[], expectedCode: number) {
  const directory = resolve(".wrangler/preparer-runtime-tests/" + randomUUID()); mkdirSync(directory, { recursive: true });
  const report = join(directory, "report.json");
  const result = spawnSync(compiled(), [...args, "--report", report], { windowsHide: true, encoding: "utf8", timeout: 120000 });
  assert.equal(result.status, expectedCode, result.error?.message || result.stderr);
  return JSON.parse(readFileSync(report, "utf8"));
}

test("preparador: detector, semântica, publicação atômica, mapeamento e pesquisa passam nos autotestes .NET", { skip }, () => {
  const report = run(["--self-test"], 0);
  assert.equal(report.status, "passed");
  assert.deepEqual(report.checks, ["consistency", "semantic", "package", "atomic-publication", "mapping", "search"]);
});

test("preparador: pacote do importador TypeScript é validado integralmente e truncamento é rejeitado", { skip }, () => {
  const directory = resolve(".wrangler/preparer-package-tests/" + randomUUID()); mkdirSync(directory, { recursive: true });
  const fixture = fixturePackage(), valid = join(directory, "SINTETICO.ci.ndjson"), invalid = join(directory, "INCOMPLETO.ci.ndjson");
  writeFileSync(valid, fixture.data); writeFileSync(invalid, fixture.data.slice(0, -20));
  const report = run(["--validate-package", valid], 0);
  assert.equal(report.status, "valid"); assert.equal(report.package.Sha256, fixture.sha256);
  assert.equal(report.package.RawRows, 4); assert.equal(report.package.ProjectionRows, 4);
  const rejected = run(["--validate-package", invalid], 1);
  assert.equal(rejected.status, "failed"); assert.equal(rejected.type, "InvalidDataException");
  assert.deepEqual(readFileSync(valid), Buffer.from(fixture.data));
});

test("preparador: falha de conexão produz diagnóstico e não anuncia exportação", { skip }, () => {
  const report = run(["--check-model", "--server", "localhost:1", "--database", "SINTETICO-SEM-SERVIDOR"], 1);
  assert.equal(report.status, "failed"); assert.match(report.error, /conectar ao modelo local/);
  assert.equal(report.productionImport, false);
});
