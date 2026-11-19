import { change, metrics, type Metric, type Report } from "../shared/domain";

type Cell = string | number | null;
const xml = (value: string) => Array.from(value).filter((char) => {
  const code = char.codePointAt(0)!;
  return code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || code >= 0x10000;
}).join("").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!);
const encoder = new TextEncoder();
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(files: Record<string, string>): Uint8Array {
  const chunks: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  for (const [path, source] of Object.entries(files)) {
    const name = encoder.encode(path), data = encoder.encode(source), crc = crc32(data);
    const header = new Uint8Array(30 + name.length), h = new DataView(header.buffer);
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x800, true);
    h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true);
    h.setUint16(26, name.length, true); header.set(name, 30);
    chunks.push(header, data);
    const entry = new Uint8Array(46 + name.length), e = new DataView(entry.buffer);
    e.setUint32(0, 0x02014b50, true); e.setUint16(4, 20, true); e.setUint16(6, 20, true); e.setUint16(8, 0x800, true);
    e.setUint32(16, crc, true); e.setUint32(20, data.length, true); e.setUint32(24, data.length, true);
    e.setUint16(28, name.length, true); e.setUint32(42, offset, true); entry.set(name, 46);
    central.push(entry); offset += header.length + data.length;
  }
  const centralSize = central.reduce((size, chunk) => size + chunk.length, 0);
  const end = new Uint8Array(22), view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true); view.setUint16(8, central.length, true); view.setUint16(10, central.length, true);
  view.setUint32(12, centralSize, true); view.setUint32(16, offset, true);
  const result = new Uint8Array(offset + centralSize + end.length);
  let index = 0;
  for (const chunk of [...chunks, ...central, end]) { result.set(chunk, index); index += chunk.length; }
  return result;
}
const col = (index: number): string => index < 26 ? String.fromCharCode(65 + index) : col(Math.floor(index / 26) - 1) + col(index % 26);
/** Strings use explicit inline-string cells. A customer name beginning with '=' stays text. */
export function makeWorkbook(sheets: { name: string; rows: Cell[][] }[]): Uint8Array {
  const files: Record<string, string> = {
    "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' + sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") + "</Types>",
    "_rels/.rels": '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    "xl/workbook.xml": '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + sheets.map((sheet, index) => `<sheet name="${xml(sheet.name.slice(0, 31))}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("") + "</sheets></workbook>",
    "xl/_rels/workbook.xml.rels": '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("") + "</Relationships>",
  };
  sheets.forEach((sheet, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" state="frozen"/></sheetView></sheetViews><sheetData>' + sheet.rows.map((row, r) => `<row r="${r + 1}">` + row.map((value, c) => value === null ? "" : typeof value === "number" && Number.isFinite(value) ? `<c r="${col(c)}${r + 1}"><v>${value}</v></c>` : `<c r="${col(c)}${r + 1}" t="inlineStr"><is><t xml:space="preserve">${xml(String(value))}</t></is></c>`).join("") + "</row>").join("") + "</sheetData></worksheet>";
  });
  return zip(files);
}
export function reportSheet(report: Report, title = "Resultados") {
  const available = report.sourceInfo?.capabilities?.metrics ?? Object.keys(report.total.values) as Metric[];
  const rows: Cell[][] = [["Código", "Identificação", ...available.flatMap((metric) => {
    const label = (report.sourceInfo?.capabilities?.labels?.[metric] ?? metrics[metric].label) + (metrics[metric].unit === "money" ? " (R$)" : "");
    return [label + " atual", label + " anterior", label + " diferença absoluta", label + (metric === "margin" ? " variação (p.p.)" : " variação (%)")];
  })]];
  for (const row of [report.total, ...report.rows]) rows.push([row.key ?? "", row.name, ...available.flatMap((metric) => {
    const pair = row.values[metric];
    return [pair?.current ?? null, pair?.previous ?? null, pair?.current != null && pair?.previous != null ? pair.current - pair.previous : null, pair ? change(pair, metric) : null];
  })]);
  return { name: title, rows };
}
export function downloadWorkbook(sheets: Parameters<typeof makeWorkbook>[0], filename: string) {
  const bytes = makeWorkbook(sheets), buffer = new ArrayBuffer(bytes.length);
  new Uint8Array(buffer).set(bytes);
  const url = URL.createObjectURL(new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const link = document.createElement("a"); link.href = url; link.download = filename + ".xlsx"; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function exportReport(report: Report) {
  downloadWorkbook([reportSheet(report), { name: "Contexto", rows: [
    ["Fonte", report.source], ["Período", `${report.plan.filters.from} a ${report.plan.filters.to}`],
    ["Extração", report.sourceInfo?.extractedAt ?? report.asOf], ["Versão", report.sourceInfo?.versionId ?? "Consulta online"],
    ["Limite", report.truncated ? "Ranking limitado aos primeiros 30 registros; totais abrangem o escopo autorizado." : "Todos os registros retornados."],
    ["Filtros", JSON.stringify(report.plan.filters)], ["Indicadores indisponíveis", "Células vazias indicam ausência de valor; não representam zero."],
  ] }], "commercial-insight-" + report.plan.filters.to);
}
