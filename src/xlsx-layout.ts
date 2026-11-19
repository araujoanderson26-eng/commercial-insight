import { metrics, type Metric } from '../shared/domain';
import { availableMetrics, metricLabel, reportContext, type Cell, type ExportSheet } from './export-model';
export const escapeXml = (v: string) => Array.from(v).filter(c => { const n = c.codePointAt(0)!; return n === 9 || n === 10 || n === 13 || (n >= 32 && n <= 0xd7ff) || (n >= 0xe000 && n <= 0xfffd) || (n >= 0x10000 && n <= 0x10ffff); }).join('').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));
export const column = (n: number): string => n < 26 ? String.fromCharCode(65 + n) : column(Math.floor(n / 26) - 1) + column(n % 26);
const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main', rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const doc = (tag: string, body: string) => `<?xml version="1.0" encoding="UTF-8"?>${tag}${body}`;
const money = '[$R$-416] #,##0.00;[Red]-[$R$-416] #,##0.00';
export const stylesXml = doc(`<styleSheet xmlns="${ns}">`, `<numFmts count="4"><numFmt numFmtId="164" formatCode="${escapeXml(money)}"/><numFmt numFmtId="165" formatCode="+0.00%;-0.00%;0.00%"/><numFmt numFmtId="166" formatCode="+0.00&quot; p.p.&quot;;-0.00&quot; p.p.&quot;;0.00&quot; p.p.&quot;"/><numFmt numFmtId="167" formatCode="0.00&quot;%&quot;"/></numFmts>` +
    `<fonts count="5"><font><sz val="11"/><color rgb="FF24364B"/><name val="Arial"/></font><font><b/><sz val="18"/><color rgb="FFFFFFFF"/><name val="Arial"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Arial"/></font><font><b/><sz val="11"/><color rgb="FF17304F"/><name val="Arial"/></font><font><u/><sz val="11"/><color rgb="FF6750D8"/><name val="Arial"/></font></fonts>` +
    `<fills count="6"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>${['17304F', '6750D8', 'F1F4F8', 'E8EEF5'].map(c => `<fill><patternFill patternType="solid"><fgColor rgb="FF${c}"/><bgColor indexed="64"/></patternFill></fill>`).join('')}</fills>` +
    `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top style="thin"><color rgb="FF17304F"/></top><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="24">${[[0, 0, 0, 0], [1, 2, 0, 0], [0, 0, 0, 0], [2, 2, 0, 0], [2, 3, 0, 0], [0, 0, 0, 0], [0, 4, 0, 0], [0, 0, 164, 0], [0, 4, 164, 0], [0, 0, 3, 0], [0, 4, 3, 0], [0, 0, 165, 0], [0, 4, 165, 0], [0, 0, 166, 0], [0, 4, 166, 0], [3, 5, 0, 1], [3, 5, 164, 1], [3, 5, 3, 1], [3, 5, 165, 1], [3, 5, 166, 1], [4, 0, 0, 0], [0, 0, 167, 0], [0, 4, 167, 0], [3, 5, 167, 1]].map(([f, fill, n, b], i) => `<xf numFmtId="${n}" fontId="${f}" fillId="${fill}" borderId="${b}" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1" applyNumberFormat="1"><alignment horizontal="${[3, 4].includes(i) ? 'center' : n ? 'right' : 'left'}" vertical="center" wrapText="1"/></xf>`).join('')}</cellXfs>` +
    `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="2"><dxf><font><color rgb="FF16704A"/></font></dxf><dxf><font><color rgb="FFB72B39"/></font></dxf></dxfs></styleSheet>`);
function cell(value: Cell, c: number, r: number, s = 0) { const ref = column(c) + r; if (value === null)
    return `<c r="${ref}" s="${s}"/>`; return typeof value === 'number' && Number.isFinite(value) ? `<c r="${ref}" s="${s}"><v>${value}</v></c>` : `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(value))}</t></is></c>`; }
const row = (r: number, values: Cell[], style = 0, height = 26) => `<row r="${r}" ht="${height}" customHeight="1">${values.map((v, c) => cell(v, c, r, style)).join('')}</row>`;
function band(r: number, text: string, width: number, style: number, height = 28) { return row(r, [text, ...Array(width - 1).fill('')], style, height); }
function safeNames(sheets: ExportSheet[]) { const used = new Set<string>(); return sheets.map(s => { const base = s.name.replace(/[\\/*?:[\]]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 31) || 'Relatório'; let name = base, n = 2; while (used.has(name.toLowerCase()))
    name = base.slice(0, 26) + ' ' + n++; used.add(name.toLowerCase()); return { ...s, name }; }); }
const quoteSheet = (s: string) => "'" + s.replaceAll("'", "''") + "'";
type ChartSpec = {
    sheet: string;
    name: string;
    metric: Metric;
    start: number;
    end: number;
    keyCol: string;
    current: string;
    previous: string;
    chartRow: number;
    monthly: boolean;
};
function chartXml(spec: ChartSpec, sheet: ExportSheet) {
    const { sheet: name, start, end, keyCol, current, previous, metric } = spec;
    const r = sheet.report!;
    const labels = r.rows.slice(0, end - start + 1).map(v => keyCol === 'A' ? v.key ?? v.name : v.name);
    const numberFormat = metrics[metric].unit === 'money' ? money : metrics[metric].unit === 'count' ? '#,##0' : '0.00"%"';
    const magnitude = Math.max(...r.rows.slice(0, end - start + 1).flatMap(v => [Math.abs(v.values[metric].current ?? 0), Math.abs(v.values[metric].previous ?? 0)]));
    const scale = metrics[metric].unit === 'money' ? (magnitude >= 1000000 ? 1000000 : magnitude >= 1000 ? 1000 : 1) : 1;
    const axisFormat = scale === 1000000 ? '0.0,,' : scale === 1000 ? '0,' : metrics[metric].unit === 'count' ? '#,##0' : numberFormat;
    const axisTitle = metrics[metric].unit === 'money' ? (scale === 1000000 ? 'R$ (milhões)' : scale === 1000 ? 'R$ (mil)' : 'R$') : metrics[metric].unit === 'count' ? 'Quantidade' : '%';
    const series = [['Atual', current, '6750D8', 'current'], ['Ano anterior', previous, 'A6B9D0', 'previous']].map(([title, c, color, p], i) => `<c:ser><c:idx val="${i}"/><c:order val="${i}"/><c:tx><c:v>${title}</c:v></c:tx><c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln w="25400"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:ln></c:spPr><c:cat><c:strRef><c:f>${escapeXml(quoteSheet(name) + '!$' + keyCol + '$' + start + ':$' + keyCol + '$' + end)}</c:f><c:strCache><c:ptCount val="${labels.length}"/>${labels.map((v, j) => `<c:pt idx="${j}"><c:v>${escapeXml(v)}</c:v></c:pt>`).join('')}</c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>${escapeXml(quoteSheet(name) + '!$' + c + '$' + start + ':$' + c + '$' + end)}</c:f><c:numCache><c:formatCode>${escapeXml(numberFormat)}</c:formatCode><c:ptCount val="${labels.length}"/>${r.rows.slice(0, labels.length).map((v, j) => v.values[metric][p as 'current' | 'previous'] === null ? '' : `<c:pt idx="${j}"><c:v>${v.values[metric][p as 'current' | 'previous']}</c:v></c:pt>`).join('')}</c:numCache></c:numRef></c:val></c:ser>`).join('');
    const rich = (text: string) => `<c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1200"/></a:pPr><a:r><a:t>${escapeXml(text)}</a:t></a:r></a:p></c:rich></c:tx>`;
    const plot = spec.monthly ? `<c:lineChart><c:grouping val="standard"/>${series}<c:axId val="100"/><c:axId val="200"/></c:lineChart>` : `<c:barChart><c:barDir val="bar"/><c:grouping val="clustered"/>${series}<c:gapWidth val="80"/><c:overlap val="0"/><c:axId val="100"/><c:axId val="200"/></c:barChart>`;
    return doc('<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">', `<c:lang val="pt-BR"/><c:chart><c:title>${rich(spec.name)}<c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>${plot}<c:catAx><c:axId val="100"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${spec.monthly ? 'b' : 'l'}"/><c:tickLblPos val="nextTo"/><c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1100"><a:solidFill><a:srgbClr val="24364B"/></a:solidFill><a:latin typeface="Arial"/></a:defRPr></a:pPr><a:endParaRPr lang="pt-BR"/></a:p></c:txPr><c:crossAx val="200"/><c:crosses val="autoZero"/></c:catAx><c:valAx><c:axId val="200"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${spec.monthly ? 'l' : 'b'}"/><c:majorGridlines/><c:title>${rich(axisTitle)}<c:overlay val="0"/></c:title><c:numFmt formatCode="${escapeXml(axisFormat)}" sourceLinked="0"/><c:tickLblPos val="nextTo"/><c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1100"><a:solidFill><a:srgbClr val="24364B"/></a:solidFill><a:latin typeface="Arial"/></a:defRPr></a:pPr><a:endParaRPr lang="pt-BR"/></a:p></c:txPr><c:crossAx val="100"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx></c:plotArea><c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`);
}
const relation = (id: string, type: string, target: string) => `<Relationship Id="${id}" Type="${rel}/${type}" Target="${escapeXml(target)}"/>`;
function drawing(charts: ChartSpec[]) { return doc('<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="' + rel + '">', charts.map((c, i) => `<xdr:twoCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${c.chartRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>8</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${c.chartRow + 19}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${i + 2}" name="Gráfico ${i + 1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId${i + 1}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`).join('') + '</xdr:wsDr>'); }
export function workbookParts(input: ExportSheet[]): Record<string, string> {
    if (!input.length)
        throw Error('Selecione ao menos uma aba para exportar.');
    const reports = input.filter(s => s.report);
    const summary = reports.length ? { name: 'Resumo Executivo', rows: [] as Cell[][] } : null;
    const sheets = safeNames(summary ? [summary, ...input] : input), files: Record<string, string> = {};
    const overrides: string[] = [];
    const titles: string[] = [];
    const charts: ChartSpec[] = sheets.flatMap(s => { if (!s.report?.rows.length)
        return []; const r = s.report, metric = availableMetrics(r).includes(r.plan.metric) ? r.plan.metric : availableMetrics(r)[0]; if (!metric)
        return []; const ms = availableMetrics(r), n = r.plan.group === 'month' ? r.rows.length : Math.min(10, r.rows.length); return [{ sheet: s.name, name: (r.plan.group === 'month' ? 'Evolução mensal' : `Primeiros ${n} do ranking exportado`) + ': ' + metricLabel(r, metric), metric, start: 9, end: 8 + n, keyCol: r.rows.slice(0, n).every(v => v.key) ? 'A' : 'B', current: column(2 + ms.indexOf(metric) * 4), previous: column(3 + ms.indexOf(metric) * 4), chartRow: 0, monthly: r.plan.group === 'month' }]; });
    charts.forEach((c, i) => { c.chartRow = 30 + i * 22; files[`xl/charts/chart${i + 1}.xml`] = chartXml(c, sheets.find(s => s.name === c.sheet)!); overrides.push(`<Override PartName="/xl/charts/chart${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`); });
    sheets.forEach((s, index) => {
        const r = s.report, ms = r ? availableMetrics(r) : [], isSummary = index === 0 && Boolean(summary), width = isSummary ? 8 : r ? Math.max(6, s.rows[0].length) : Math.max(2, ...s.rows.map(v => v.length)), last = column(width - 1);
        let data = '', merges: string[] = [], links: string[] = [], end = 7;
        const mergeBand = (n: number, text: string, style: number, height = 28) => { const span = r ? 2 : width; data += band(n, text, span, style, height); merges.push(`A${n}:${column(span - 1)}${n}`); };
        mergeBand(1, isSummary ? 'Commercial Insight — Relatório Comercial' : s.name, 1, 38);
        if (isSummary) {
            const report = reports[0].report!;
            const context = reportContext(report);
            mergeBand(2, String(input.find(s => s.name === 'Pauta')?.rows.find(v => v[0] === 'Cliente')?.[1] ?? (report.plan.filters.client ? 'Cliente ' + report.plan.filters.client : filterScope(report))), 2, 28);
            context.forEach((v, j) => mergeBand(3 + j, v, 2, j === 1 ? Math.min(140, 22 + Math.ceil(v.length / 150) * 12) : 24));
            let n = 3 + context.length;
            mergeBand(n++, 'Gerado em ' + new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) + ' (Brasília)', 2, 22);
            data += row(++n, ['Indicador', 'Atual', 'Ano anterior', 'Diferença', 'Variação'], 4, 24);
            n++;
            for (const m of availableMetrics(report)) {
                const p = report.total.values[m], v = p.current !== null && p.previous !== null ? p.current - p.previous : null;
                const cv = changeValue(report, m);
                data += `<row r="${n}" ht="24" customHeight="1">${cell(metricLabel(report, m), 0, n, 15)}${[p.current, p.previous, v, cv].map((x, j) => cell(x, j + 1, n, j === 3 ? m === 'margin' ? 19 : 18 : metrics[m].unit === 'money' ? 16 : metrics[m].unit === 'percent' ? (j === 2 ? 19 : 23) : 17)).join('')}</row>`;
                n++;
            }
            mergeBand(++n, 'Índice de conteúdo', 3, 22);
            n++;
            sheets.slice(1).forEach(target => { data += row(n, [target.name, 'Abrir aba'], 20, 20); links.push(`<hyperlink ref="A${n}:B${n}" location="${escapeXml(quoteSheet(target.name) + '!A1')}" display="${escapeXml(target.name)}"/>`); n++; });
            // Reserve rows for charts without covering the index or disclosures.
            const chartStart = n + 1;
            charts.forEach((c, i) => { c.chartRow = chartStart + i * 22; });
            end = charts.length ? chartStart + charts.length * 22 : n;
            for (let y = n; y <= end; y++)
                data += row(y, [], 0, y < chartStart ? 18 : 24);
        }
        else {
            const context = r ? reportContext(r) : reports[0]?.report ? reportContext(reports[0].report) : ['Dados exportados pelo aplicativo'];
            mergeBand(2, context[0], 2, 32);
            mergeBand(3, context[1] ?? '', 2, Math.min(180, 28 + Math.ceil((context[1]?.length ?? 0) / (r ? 60 : Math.max(70, width * 12))) * 14));
            mergeBand(4, context[2] ?? '', 2, 40);
            mergeBand(5, context.slice(3).join(' '), 2, Math.min(220, 28 + Math.ceil(context.slice(3).join(' ').length / Math.max(70, width * 12)) * 14));
            if (r) {
                data += `<row r="6" ht="28" customHeight="1">${cell('Cadastro', 0, 6, 3)}${cell('', 1, 6, 3)}${ms.map((m, j) => [cell(metricLabel(r, m) + (metrics[m].unit === 'money' ? ' (R$)' : ''), 2 + j * 4, 6, 3), ...Array.from({ length: 3 }, (_, k) => cell('', 3 + j * 4 + k, 6, 3))].join('')).join('')}</row>`;
                merges.push('A6:B6', ...ms.map((_, j) => `${column(2 + j * 4)}6:${column(5 + j * 4)}6`));
                data += row(7, ['Código', 'Identificação', ...ms.flatMap(m => ['Atual', 'Ano anterior', 'Diferença', m === 'margin' ? 'Variação (p.p.)' : 'Variação (%)'])], 4, 38);
                s.rows.slice(1).forEach((values, j) => { const n = 8 + j, total = j === 0; let h = 28 + Math.max(0, Math.ceil(String(values[1] ?? '').length / 44) - 1) * 14; data += `<row r="${n}" ht="${Math.min(390, h)}" customHeight="1">${values.map((v, c) => { if (c < 2)
                    return cell(v, c, n, total ? 15 : j % 2 ? 6 : 5); const m = ms[Math.floor((c - 2) / 4)], part = (c - 2) % 4, alt = j % 2 ? 1 : 0; let style = metrics[m].unit === 'money' ? 7 : metrics[m].unit === 'percent' ? (part < 2 ? 21 : 13) : 9; let value = v; if (part === 3) {
                    style = m === 'margin' ? 13 : 11;
                    if (v === null && values[c - 3] !== null && values[c - 2] !== null)
                        value = 'Não comparável';
                    else if (typeof v === 'number' && m !== 'margin')
                        value = v / 100;
                } if (total)
                    style = style === 21 ? 23 : style === 7 ? 16 : style === 9 ? 17 : style === 11 ? 18 : 19;
                else
                    style += alt; return cell(value, c, n, typeof value === 'string' ? total ? 15 : 5 + alt : style); }).join('')}</row>`; });
                end = 7 + s.rows.length - 1;
            }
            else {
                const pairs = width === 2;
                data += row(7, pairs ? ['Informação', 'Conteúdo'] : s.rows[0] ?? [], 4, 34);
                const body = pairs ? s.rows : s.rows.slice(1);
                body.forEach((v, j) => { data += row(j + 8, v, j % 2 ? 6 : 5, Math.min(390, 26 + Math.ceil(Math.max(...v.map(x => String(x ?? '').length)) / 85) * 14)); });
                end = 7 + body.length;
            }
            if (summary)
                links.push(`<hyperlink ref="A1" location="'Resumo Executivo'!A1" display="Voltar ao resumo"/>`);
        }
        const cols = isSummary ? Array.from({ length: 8 }, (_, i) => `<col min="${i + 1}" max="${i + 1}" width="${i === 0 ? 28 : i <= 4 ? 23 : 8}" customWidth="1"/>`).join('') : Array.from({ length: width }, (_, i) => `<col min="${i + 1}" max="${i + 1}" width="${i === 0 ? 16 : i === 1 ? r ? 40 : 100 : 18}" customWidth="1"/>`).join('');
        const cf = r ? ms.map((m, j) => [4 + j * 4, 5 + j * 4].map(c => `<conditionalFormatting sqref="${column(c)}8:${column(c)}${end}"><cfRule type="cellIs" dxfId="0" priority="${j * 4 + c % 2 * 2 + 1}" operator="${metrics[m].up ? 'greaterThan' : 'lessThan'}"><formula>0</formula></cfRule><cfRule type="cellIs" dxfId="1" priority="${j * 4 + c % 2 * 2 + 2}" operator="${metrics[m].up ? 'lessThan' : 'greaterThan'}"><formula>0</formula></cfRule></conditionalFormatting>`).join('')).join('') : '';
        const breaks = isSummary && charts.length ? `<rowBreaks count="${charts.length}" manualBreakCount="${charts.length}">${charts.map(c => `<brk id="${c.chartRow}" max="16383" man="1"/>`).join('')}</rowBreaks>` : r && ms.length > 1 ? `<colBreaks count="${ms.length - 1}" manualBreakCount="${ms.length - 1}">${ms.slice(1).map((_, j) => `<brk id="${6 + j * 4}" max="1048575" man="1"/>`).join('')}</colBreaks>` : '';
        files[`xl/worksheets/sheet${index + 1}.xml`] = doc(`<worksheet xmlns="${ns}" xmlns:r="${rel}">`, `<sheetPr><pageSetUpPr fitToPage="0"/></sheetPr><dimension ref="A1:${last}${end}"/><sheetViews><sheetView workbookViewId="0" showGridLines="0">${isSummary ? '' : `<pane xSplit="${r ? 2 : 0}" ySplit="7" topLeftCell="${r ? 'C' : 'A'}8" activePane="${r ? 'bottomRight' : 'bottomLeft'}" state="frozen"/>`}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="${isSummary ? 18 : 24}"/><cols>${cols}</cols><sheetData>${data}</sheetData>${!isSummary && end > 7 ? `<autoFilter ref="A7:${last}${end}"/>` : ''}${merges.length ? `<mergeCells count="${merges.length}">${merges.map(v => `<mergeCell ref="${v}"/>`).join('')}</mergeCells>` : ''}${cf}${links.length ? '<hyperlinks>' + links.join('') + '</hyperlinks>' : ''}<printOptions horizontalCentered="1"/><pageMargins left="0.35" right="0.35" top="0.5" bottom="0.5" header="0.2" footer="0.2"/><pageSetup paperSize="9" orientation="landscape" scale="85"/><headerFooter><oddHeader>&amp;LCommercial Insight&amp;C${r ? escapeXml(r.plan.filters.from + " a " + r.plan.filters.to) : ""}&amp;R${escapeXml(s.name.replaceAll("&", "&&"))}</oddHeader><oddFooter>&amp;L${r ? escapeXml(r.source + " · " + (r.sourceInfo?.versionId ?? "Consulta online")) : "Relatório comercial"}&amp;RPágina &amp;P de &amp;N</oddFooter></headerFooter>${breaks}${isSummary && charts.length ? '<drawing r:id="drawing"/>' : ''}</worksheet>`);
        overrides.push(`<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
        titles.push(`<definedName name="_xlnm.Print_Area" localSheetId="${index}">${escapeXml(quoteSheet(s.name) + '!$A$1:$' + last + '$' + end)}</definedName>`);
        if (!isSummary)
            titles.push(`<definedName name="_xlnm.Print_Titles" localSheetId="${index}">${escapeXml(quoteSheet(s.name) + (r ? '!$6:$7' : '!$1:$7') + (r ? ',' + quoteSheet(s.name) + '!$A:$B' : ''))}</definedName>`);
    });
    if (charts.length) {
        files['xl/drawings/drawing1.xml'] = drawing(charts);
        files['xl/drawings/_rels/drawing1.xml.rels'] = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${charts.map((_, i) => relation('rId' + (i + 1), 'chart', `../charts/chart${i + 1}.xml`)).join('')}</Relationships>`;
        files['xl/worksheets/_rels/sheet1.xml.rels'] = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relation('drawing', 'drawing', '../drawings/drawing1.xml')}</Relationships>`;
        overrides.push('<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>');
    }
    files['xl/styles.xml'] = stylesXml;
    overrides.push('<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>');
    files['[Content_Types].xml'] = `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${overrides.join('')}</Types>`;
    files['_rels/.rels'] = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relation('rId1', 'officeDocument', 'xl/workbook.xml')}</Relationships>`;
    files['xl/workbook.xml'] = doc(`<workbook xmlns="${ns}" xmlns:r="${rel}">`, `<bookViews><workbookView/></bookViews><sheets>${sheets.map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><definedNames>${titles.join('')}</definedNames></workbook>`);
    files['xl/_rels/workbook.xml.rels'] = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => relation('rId' + (i + 1), 'worksheet', `worksheets/sheet${i + 1}.xml`)).join('')}${relation('styles', 'styles', 'styles.xml')}</Relationships>`;
    return files;
}
function filterScope(r: NonNullable<ExportSheet['report']>) { return r.plan.filters.region ? 'Representante ' + r.plan.filters.region : r.plan.filters.regional ? 'Regional ' + r.plan.filters.regional : 'Escopo comercial autorizado'; }
function changeValue(r: NonNullable<ExportSheet['report']>, m: Metric): Cell { const p = r.total.values[m]; if (p.current === null || p.previous === null)
    return null; if (m === 'margin')
    return p.current - p.previous; return p.previous > 0 ? (p.current - p.previous) / p.previous : 'Não comparável'; }
