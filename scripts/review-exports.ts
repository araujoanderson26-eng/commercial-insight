/** Produce only synthetic review artifacts using the SAME browser export modules. No providers. */
import fs from'node:fs';import{resolve}from'node:path';import{chromium,expect}from'@playwright/test';
import{makeWorkbook,reportSheet}from'../src/exports';import{executivePrintHtml}from'../src/print-report';import{syntheticReport,syntheticVisit}from'../tests/export-fixtures';
const root=resolve('outputs/executive-exports');fs.mkdirSync(root,{recursive:true});
const visit=syntheticVisit();const cases=[{name:'relatorio-produtos',r:syntheticReport(40),sheets:[reportSheet(syntheticReport(40))]},
 {name:'relatorio-curto',r:syntheticReport(2,'client'),sheets:[reportSheet(syntheticReport(2,'client'))]},
 {name:'visita-comercial',r:visit.timeline,visit,sheets:[reportSheet(visit.timeline,'Histórico'),reportSheet(visit.products,'Mix'),reportSheet(visit.productLosses,'Perdas de mix'),{name:'Pauta',rows:[['Cliente',visit.client.name],['Resumo',visit.summary],...visit.objectives.map(v=>['Objetivo',v]),...visit.questions.map(v=>['Pergunta',v]),...visit.recommendations.map(v=>['Próximo passo',v]),...visit.limitations.map(v=>['Limitação',v])]}]}];
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});const results=[];
fs.writeFileSync(resolve(root,'expected-values.json'),JSON.stringify(cases.map(c=>({file:c.name+'.xlsx',sheets:c.sheets.map(s=>({name:s.name,rows:s.rows,report:'report'in s?Boolean(s.report):false}))})),null,2));
try{for(const c of cases){const start=performance.now(),bytes=makeWorkbook(c.sheets);fs.writeFileSync(resolve(root,c.name+'.xlsx'),bytes);const elapsed=performance.now()-start;const html=executivePrintHtml(c.r,c.visit);fs.writeFileSync(resolve(root,c.name+'.html'),html);
 const page=await browser.newPage();await page.route('**/*',route=>route.abort());await page.setContent(html,{waitUntil:'load'});await page.emulateMedia({media:'print'});await expect(page.locator('table').first()).toBeVisible();
 const overflow=await page.locator('td,th,svg').evaluateAll(els=>els.filter(el=>el.scrollWidth>el.clientWidth+2).map(el=>({tag:el.tagName,text:el.textContent?.slice(0,80)})));if(overflow.length)throw Error('Export element overflow: '+JSON.stringify(overflow));
 await page.pdf({path:resolve(root,c.name+'.pdf'),preferCSSPageSize:true,printBackground:true});await page.close();results.push({sample:c.name,xlsxBytes:bytes.length,xlsxMilliseconds:Math.round(elapsed),domOverflow:overflow.length});
 }fs.writeFileSync(resolve(root,'generation.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results));
}finally{await browser.close();}
