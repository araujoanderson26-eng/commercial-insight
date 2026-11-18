import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";

// Only reviewed source files are public. Excludes build output, local mappings and packages.
const files = ["ComercialInsight.Preparador.csproj", "packages.lock.json", "Program.cs", "Instalar.cmd", "Instalar.ps1", "Registrar.ps1", "README.md"];
const crc32 = (bytes) => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
};
const chunks = [], central = [];
let offset = 0;
for (const file of files) {
  const name = Buffer.from("Preparador-Comercial-Insight/" + file);
  const data = readFileSync(new URL("../tools/preparador/" + file, import.meta.url));
  const crc = crc32(data), local = Buffer.alloc(30), entry = Buffer.alloc(46);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
  local.writeUInt16LE(0x21, 12); // Valid deterministic DOS date: 1980-01-01.
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x800, 8);
  entry.writeUInt16LE(0x21, 14);
  entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
  chunks.push(local, name, data); central.push(entry, name); offset += local.length + name.length + data.length;
}
const directory = Buffer.concat(central), end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
mkdirSync("dist", { recursive: true });
writeFileSync("dist/preparador-comercial-insight.zip", Buffer.concat([...chunks, directory, end]));
copyFileSync("docs/ATUALIZACAO-DADOS.md", "dist/atualizacao-dados.md");
console.log("Preparador e instruções incluídos nos assets públicos; nenhum dado de negócio foi incluído.");
