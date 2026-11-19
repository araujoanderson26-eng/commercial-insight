/** Small, visibly synthetic package for isolated homologation. No production inputs. */
import { nativeFixture, nativeRows } from "../tests/native-fixtures";
import { bytes, hash } from "../tests/manual-fixtures";

export function syntheticHmlPackage(invalid = false) {
  const rows = structuredClone(nativeRows);
  rows.c = rows.c.map(row => [...row, `Cliente SINTÉTICO ${row[0]}`]);
  const pkg = nativeFixture(rows, manifest => {
    manifest.model.name = "SINTÉTICO HML — SEM DADOS REAIS";
    manifest.inventory.tables.find(table => table.id === "c")!.columns.push({ name: "Cliente", type: "String" });
    if (invalid) manifest.controls.find(control => control.metric === "revenue" && control.context === "total")!.expected = "-600";
  });
  const productBody = JSON.stringify({ kind: "rows", table: "products", part: 1, rows: [
    { row: 1, values: ["P", "Produto SINTÉTICO P"] }, { row: 2, values: ["Q", "Produto SINTÉTICO Q"] },
  ] }) + "\n";
  pkg.manifest.inventory.tables.push({ id: "products", name: "Base Produtos", columns: [{ name: "Codigo Item", type: "String" }, { name: "Descrição do item", type: "String" }],
    rowCount: 2, sourceRowCount: 2, allowEmpty: false, storageMode: "Import", partitions: [], parts: [{ index: 1, rows: 2, bytes: bytes(productBody).length, sha256: hash(bytes(productBody)) }] });
  const text = JSON.stringify(pkg.manifest) + "\n" + pkg.text.slice(pkg.text.indexOf("\n") + 1) + productBody;
  return { manifest: pkg.manifest, data: bytes(text), sha256: hash(bytes(text)) };
}
