import test from'node:test';import assert from'node:assert/strict';
import{makeWorkbook,reportSheet}from'../src/exports';import{workbookParts}from'../src/xlsx-layout';import{executivePrintHtml}from'../src/print-report';import{syntheticReport,syntheticVisit}from'./export-fixtures';
test('styled XLSX retains every original number and code with bounded filters and panes',()=>{
 const r=syntheticReport(),s=reportSheet(r),parts=workbookParts([s]);const xml=parts['xl/worksheets/sheet2.xml'];assert.equal(s.rows.length,42);assert.equal(s.rows[2][0],'0000001');assert.equal(s.rows[2][4],-2816.34567);
 assert.match(xml,/ySplit="7"/);assert.match(xml,/autoFilter ref="A7:V48"/);assert.match(xml,/<mergeCell ref="C6:F6"/);assert.match(xml,/<v>-3420.34567<\/v>/);assert.match(xml,/Não comparável/);assert.match(xml,/conditionalFormatting/);assert.match(parts['xl/workbook.xml'],/Print_Titles/);assert.match(parts['xl/styles.xml'],/numFmtId="164"/);assert.match(parts['xl/worksheets/sheet1.xml'],/Resumo|Commercial Insight/);
});
test('editable charts reference only exported scoped detail ranges and leave gaps for nulls',()=>{
 const r=syntheticReport(),p=workbookParts([reportSheet(r,'Mix')]);assert.match(p['xl/charts/chart1.xml'],/'Mix'!\$C\$9:\$C\$18|&apos;Mix&apos;!\$C\$9:\$C\$18/);assert.match(p['xl/charts/chart1.xml'],/dispBlanksAs val="gap"/);assert.match(p['xl/drawings/drawing1.xml'],/twoCellAnchor/);assert.match(p['xl/worksheets/_rels/sheet1.xml.rels'],/drawing/);
 assert(!Object.values(p).some(v=>/TargetMode="External"|<f>HYPERLINK/.test(v)));
});
test('literal formula-like names, XML controls, duplicate and invalid sheet names remain safe',()=>{
 const bytes=makeWorkbook([{name:'A/B',rows:[['=WEBSERVICE("https://synthetic.invalid")','000123','<&\u0001',-4,null]]},{name:'A/B',rows:[['@SUM(1)','+CMD']]}]);assert.equal(new DataView(bytes.buffer).getUint32(0,true),0x04034b50);const x=Object.values(workbookParts([{name:'A/B',rows:[['=WEBSERVICE("https://synthetic.invalid")','000123','<&\u0001',-4,null]]},{name:'A/B',rows:[['@SUM(1)','+CMD']]}])).join('');assert.match(x,/inlineStr/);assert.match(x,/&lt;&amp;/);assert.doesNotMatch(x,/<f>/);assert(!x.includes(String.fromCharCode(1)));assert.match(x,/name="A B 2"/);
});
test('PDF has complete descriptions, logical financial blocks, scope and no application controls',()=>{
 const r=syntheticReport(),html=executivePrintHtml(r);assert.match(html,/size:A4 landscape/);assert.match(html,/counter\(page\)/);assert.match(html,/table-header-group/);assert.match(html,/Não comparável/);assert.match(html,/PA - GRANEL/);assert.match(html,/SYNTHETIC-EXPORT-REVIEW/);assert.match(html,/Ranking limitado/);assert(!/<button|<nav|<script|sidebar/.test(html));assert(html.includes(r.rows[1].name.replaceAll('&','&amp;')));
 const v=syntheticVisit(),visit=executivePrintHtml(v.timeline,v);for(const label of ['Histórico','Mix','Perdas de mix','Pauta da visita','Perguntas','Limitações'])assert(visit.includes(label));
});
test('empty and small reports omit unsupported charts and keep missing cells blank',()=>{
 const r=syntheticReport(0),p=workbookParts([reportSheet(r)]);assert(!p['xl/charts/chart1.xml']);assert(!executivePrintHtml(r).includes('<svg'));const s=reportSheet(syntheticReport(2));assert.equal(s.rows[2][10],null);
});
