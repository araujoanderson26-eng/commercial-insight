import type { Report } from "../shared/domain";
import { workbookParts } from "./xlsx-layout";
import type { ExportSheet } from "./export-model";
import { reportSheet } from "./export-model";
export { reportSheet } from "./export-model";
const encoder = new TextEncoder();
function crc32(bytes: Uint8Array) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++)
            crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}
function zip(files: Record<string, string>): Uint8Array {
    const chunks: Uint8Array[] = [], central: Uint8Array[] = [];
    let offset = 0;
    for (const [path, source] of Object.entries(files)) {
        const name = encoder.encode(path), data = encoder.encode(source), crc = crc32(data);
        const header = new Uint8Array(30 + name.length), h = new DataView(header.buffer);
        h.setUint32(0, 0x04034b50, true);
        h.setUint16(4, 20, true);
        h.setUint16(6, 0x800, true);
        h.setUint32(14, crc, true);
        h.setUint32(18, data.length, true);
        h.setUint32(22, data.length, true);
        h.setUint16(26, name.length, true);
        header.set(name, 30);
        chunks.push(header, data);
        const entry = new Uint8Array(46 + name.length), e = new DataView(entry.buffer);
        e.setUint32(0, 0x02014b50, true);
        e.setUint16(4, 20, true);
        e.setUint16(6, 20, true);
        e.setUint16(8, 0x800, true);
        e.setUint32(16, crc, true);
        e.setUint32(20, data.length, true);
        e.setUint32(24, data.length, true);
        e.setUint16(28, name.length, true);
        e.setUint32(42, offset, true);
        entry.set(name, 46);
        central.push(entry);
        offset += header.length + data.length;
    }
    const centralSize = central.reduce((size, chunk) => size + chunk.length, 0);
    const end = new Uint8Array(22), view = new DataView(end.buffer);
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(8, central.length, true);
    view.setUint16(10, central.length, true);
    view.setUint32(12, centralSize, true);
    view.setUint32(16, offset, true);
    const result = new Uint8Array(offset + centralSize + end.length);
    let index = 0;
    for (const chunk of [...chunks, ...central, end]) {
        result.set(chunk, index);
        index += chunk.length;
    }
    return result;
}
/** Pure browser-compatible Open XML writer, with no runtime library or network calls. */
export function makeWorkbook(sheets: ExportSheet[]): Uint8Array { return zip(workbookParts(sheets)); }
export function downloadWorkbook(sheets: ExportSheet[], filename: string) { const bytes = makeWorkbook(sheets), buffer = new ArrayBuffer(bytes.length); new Uint8Array(buffer).set(bytes); const url = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })); const link = document.createElement('a'); link.href = url; link.download = filename + '.xlsx'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
export function exportReport(report: Report) { downloadWorkbook([reportSheet(report), { name: 'Contexto', rows: [['Fonte', report.source], ['Período', report.plan.filters.from + ' a ' + report.plan.filters.to], ['Extração', report.sourceInfo?.extractedAt ?? report.asOf], ['Versão', report.sourceInfo?.versionId ?? 'Consulta online'], ['Filtros', JSON.stringify(report.plan.filters)], ['Limites', report.truncated ? 'Ranking limitado; total oficial do recorte autorizado.' : 'Registros retornados pela consulta.'], ['Indisponíveis', 'Células vazias não equivalem a zero. Percentual exige base anterior positiva.']] }], 'commercial-insight-' + report.plan.filters.to); }
