/** Focused financial UI proof; synthetic data and no provider access. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium, expect } from '@playwright/test';
const root=resolve('dist');
const mime:Record<string,string>={'.js':'application/javascript','.css':'text/css','.html':'text/html','.woff2':'font/woff2','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
const server=createServer(async(req,res)=>{
  try{const path=resolve(root,'.'+new URL(req.url!,'http://localhost').pathname);if(path!==root&&!path.startsWith(root+sep)){res.writeHead(403);return res.end();}
    let data:Buffer;try{data=await readFile(path);res.setHeader('Content-Type',mime[extname(path)]??'application/octet-stream');}
    catch{data=await readFile(resolve(root,'index.html'));res.setHeader('Content-Type','text/html');}res.end(data);
  }catch{res.writeHead(500);res.end();}
});
await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
const address=server.address();if(!address||typeof address==='string')throw Error('Missing test server');
const origin='http://127.0.0.1:'+address.port;
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
let paidRequests=0,authorized=true;const errors:string[]=[];
try{
  const context=await browser.newContext({locale:'pt-BR',viewport:{width:1440,height:1000}});
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();
    if(!url.pathname.startsWith('/api/'))return route.continue();
    if(url.pathname==='/api/chat'){paidRequests++;return route.abort();}
    let data:unknown=[];
    if(url.pathname==='/api/me')data={user:{id:'synthetic',name:'Admin SINTETICO',role:'admin',email:'admin@synthetic.test',active:true,national:true,regions:[],clients:[],entraOid:null},policyVersion:'synthetic',expires:Date.now()/1000+600,integrations:{configured:false,mode:'delegated',linked:false,ai:false},data:{source:'manual',ready:true,activeVersionId:'synthetic',extractedAt:new Date().toISOString(),stale:false}};
    else if(url.pathname==='/api/assistant/status')data={source:'manual',enabledForSource:false,credentialConfigured:false,model:'synthetic',ready:false,reason:authorized?'policy_disabled':'account_not_authorized',pending:[],message:'A IA permanece desabilitada neste teste.',...(authorized?{budget:{month:'2026-11',capUsd:20,reservedUsd:16.01,usageUpperUsd:0.123456,unknownUsageCount:1,remainingUsd:3.99,verifiedCreditRemainingUsd:0,creditValidUntil:0,alerts:[{thresholdUsd:10,event:'reservation_threshold',created:1},{thresholdUsd:16,event:'reservation_threshold',created:2},{thresholdUsd:20,event:'budget_blocked',created:3}]}}:{})};
    else if(url.pathname==='/api/data/options')data={regions:[],clients:[],products:[],categories:[],states:[],regionals:[],managers:[]};
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.name));await page.goto(origin+'/conversas');
  const budget=page.getByRole('region',{name:'Consumo da IA'});
  await expect(budget).toContainText('US$ 20.00');await expect(budget).toContainText('US$ 16.0100');
  await expect(budget).toContainText('US$ 0.123456');await expect(budget.getByRole('alert')).toHaveCount(3);
  await expect(budget).toContainText('não são o valor da fatura');await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  authorized=false;await page.reload();await expect(page.locator('.assistant-status')).toBeVisible();await expect(budget).toHaveCount(0);
  expect(errors).toEqual([]);expect(paidRequests).toBe(0);
  console.log('Financial UI passed: monthly cap, reservation/usage separation, three alerts, mobile and financial privacy. No provider calls.');
}finally{await browser.close();await new Promise<void>(done=>server.close(()=>done()));}
