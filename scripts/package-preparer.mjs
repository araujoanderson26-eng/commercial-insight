import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";

// Source allowlist excludes local mappings, packages and arbitrary build output.
const files = ["ComercialInsight.Preparador.csproj", "packages.lock.json", "Instalar.cmd", "Instalar.ps1", "Atualizar.cmd", "Atualizar.ps1", "Preparador.Setup.ps1", "RepararRegistro.cmd", "Registrar.ps1", "README.md",
  ...readdirSync("tools/preparador", { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".cs")).map((entry) => entry.name).sort()];
const crc32 = (bytes) => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
};
const entries = files.map((file) => ({ name: file, path: new URL("../tools/preparador/" + file, import.meta.url) }));
entries.push({ name: "CORRECAO-PREPARADOR.md", path: new URL("../docs/CORRECAO-PREPARADOR.md", import.meta.url) });
entries.push({ name: "MANUAL-ATUALIZACAO-SEMANAL.md", path: new URL("../docs/MANUAL-ATUALIZACAO-SEMANAL.md", import.meta.url) });
const arg = (name) => { const index = process.argv.indexOf(name); if (index < 0) return undefined; if (!process.argv[index + 1] || process.argv[index + 1].startsWith("--")) throw Error("Valor ausente: " + name); return process.argv[index + 1]; };
const runtimePath = arg("--runtime") || process.env.CI_PREPARER_RUNTIME_DIR;
const outputPath = resolve(arg("--output") || "dist/preparador-comercial-insight.zip");
if (runtimePath) {
  const runtimeRoot = resolve(runtimePath);
  const runtimeFiles = [];
  const visit = (directory) => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, item.name);
      if (item.isSymbolicLink()) throw Error("O publish não pode conter links: " + item.name);
      if (item.isDirectory()) visit(path);
      else if (item.isFile() && !item.name.endsWith(".pdb")) {
        const name = relative(runtimeRoot, path).replaceAll("\\", "/");
        if (!/\.(dll|exe|json|dat|txt|xml)$/i.test(name) || (name.endsWith(".json") && !["ComercialInsight.Preparador.deps.json", "ComercialInsight.Preparador.runtimeconfig.json"].includes(name))) throw Error("Arquivo inesperado no publish: " + name);
        const data = readFileSync(path);
        runtimeFiles.push({ path: name, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") });
        entries.push({ name: "runtime/" + name, data });
      }
    }
  };
  visit(runtimeRoot);
  const required = ["ComercialInsight.Preparador.exe", "ComercialInsight.Preparador.dll", "ComercialInsight.Preparador.deps.json", "ComercialInsight.Preparador.runtimeconfig.json", "coreclr.dll", "System.Windows.Forms.dll", "Microsoft.AnalysisServices.Core.dll", "Microsoft.AnalysisServices.Tabular.dll", "Microsoft.AnalysisServices.AdomdClient.dll"];
  for (const name of required) if (!runtimeFiles.some((file) => file.path === name)) throw Error("Publish Windows selfcontained incompleto: " + name);
  entries.push({ name: "runtime/ci-runtime-manifest.json", data: Buffer.from(JSON.stringify({ version: "1.0.2", runtime: "win-x64", selfContained: true, files: runtimeFiles }, null, 2) + "\n") });
}
const chunks = [], central = [];
let offset = 0;
for (const file of entries) {
  const name = Buffer.from("Preparador-Comercial-Insight/" + file.name);
  const data = file.data ?? readFileSync(file.path);
  const compressed = deflateRawSync(data, { level: 9 });
  const crc = crc32(data), local = Buffer.alloc(30), entry = Buffer.alloc(46);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(0x21, 12); // Valid deterministic DOS date: 1980-01-01.
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x800, 8);
  entry.writeUInt16LE(8, 10);
  entry.writeUInt16LE(0x21, 14);
  entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(compressed.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
  chunks.push(local, name, compressed); central.push(entry, name); offset += local.length + name.length + compressed.length;
}
const directory = Buffer.concat(central), end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
mkdirSync(dirname(outputPath), { recursive: true });
const zip = Buffer.concat([...chunks, directory, end]);
writeFileSync(outputPath, zip);
mkdirSync("dist", { recursive: true });
copyFileSync("docs/ATUALIZACAO-DADOS.md", "dist/atualizacao-dados.md");
console.log(`ZIP ${runtimePath ? "Windows x64 pronto (sem SDK no operador)" : "de fontes (instalação compila com SDK)"}: ${outputPath} · ${zip.length} bytes. Sem deploy ou dados comerciais.`);
