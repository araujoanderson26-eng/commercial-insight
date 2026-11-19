import test from "node:test";
import assert from "node:assert/strict";
import { change, comparison, type Filters } from "../shared/domain";
import type { DbUser } from "../worker/core";
import { nativeCustomerDetails, nativeIdentityLabels, nativePartStatements, nativePeriod, nativeSearch, queryNative } from "../worker/native-model";
import { makeStore, plan } from "./fixtures";
import { model, user } from "./fixtures";
import { compile } from "../worker/analysis";
import { nativeFixture, nativeRows } from "./native-fixtures";

const admin:DbUser={id:"semantic-admin",name:"Teste",email:"semantic@example.test",role:"admin",password:"kept",regions:"[]",clients:"[]",national:1,active:1,entra_oid:null,scope_version:1,version:1};
const january:Filters={...plan.filters,from:"2026-01",to:"2026-01"};

test("online financial measures preserve returns-only periods rather than masking them behind sales row counts",()=>{
  const dax=compile(model,user,plan);
  assert.match(dax,/"revenue_c",\s*CALCULATE\(\[Receita líquida\]/);
  assert.match(dax,/"returns_c",\s*CALCULATE\(\[Devoluções\]/);
  assert.doesNotMatch(dax,/"revenue_c",\s*IF\(/);
});

test("negative and zero baselines never become conventional growth percentages",()=>{
  const example={current:200,previous:-50};
  assert.equal(change(example,"revenue"),null);
  const c=comparison(example,"revenue");
  assert.equal(c.status,"negative-base");assert.equal(c.percent,null);assert.equal(c.absolute,250);
  assert.equal(comparison({current:100,previous:0},"gross").status,"zero-base");
  assert.equal(comparison({current:null,previous:10},"revenue").absolute,null);
  assert.equal(change({current:90,previous:100},"revenue"),-10);
  assert.equal(comparison({current:90,previous:100},"returns").favorable,true);
  assert.equal(comparison({current:90,previous:100},"revenue").favorable,false);
  assert.equal(change({current:-5,previous:-10},"margin"),5);
  assert.equal(change({current:Infinity,previous:1},"gross"),null);
});

test("partial snapshot ends the prior-year period on the equivalent calendar day",()=>{
  const m=nativeFixture().manifest;m.referenceDate="2026-11-18";m.projection.from="2023-07-01";m.projection.to="2026-11-17";
  const period=nativePeriod(m,{...january,from:"2026-01",to:"2026-11"});
  assert.deepEqual(period.current,{from:"2026-01-01",to:"2026-11-17"});
  assert.deepEqual(period.previous,{from:"2025-01-01",to:"2025-11-17"});assert.equal(period.status,"partial");
  const complete=nativePeriod(m,{...january,from:"2026-01",to:"2026-10"});
  assert.deepEqual(complete.previous,{from:"2025-01-01",to:"2025-10-31"});assert.equal(complete.status,"comparable");
  m.referenceDate="2024-02-29";m.projection.to="2024-02-29";m.projection.from="2022-01-01";
  assert.equal(nativePeriod(m,{...january,from:"2024-02",to:"2024-03"}).previous.to,"2023-02-28");
});

async function seeded(){
  const s=makeStore(),rows=structuredClone(nativeRows),pkg=nativeFixture(rows),m=pkg.manifest,version=crypto.randomUUID();
  m.inventory.tables.find(t=>t.id==="c")!.columns.push({name:"Cliente",type:"String"});
  rows.c=rows.c.map(row=>[...row,row[0]==="0001"?"Mercado Exemplo":row[0]==="0002"?"Comércio Reservado":"Cliente sem vendas"]);
  m.inventory.tables.push({id:"products",name:"Base Produtos",columns:[{name:"Codigo Item",type:"String"},{name:"Descrição do item",type:"String"}],rowCount:2,allowEmpty:false,storageMode:"Import",partitions:[],parts:[]});
  rows.products=[["P","Suco Integral"],["Q","Bebida PET"]];
  s.sql.prepare("INSERT INTO ci_imports(id,owner,actor,filename,bytes,sha256,object_key,status,base_generation,created,updated,published,manifest) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(version,admin.id,admin.name,"synthetic.ci.ndjson",pkg.data.length,pkg.sha256,"local","published",0,1,1,1,JSON.stringify(m));
  for(const t of m.inventory.tables){
    const list=rows[t.id]??[];
    await s.env.DB.batch(nativePartStatements(s.env,m,version,t.id,list.map((values,i)=>({row:i+1,values}))));
    for(const [i,values]of list.entries())s.sql.prepare("INSERT INTO ci_raw_rows VALUES(?,?,?,?)").run(version,t.id,i+1,JSON.stringify(values));
  }
  return {...s,version,m};
}

test("descriptions enrich rankings without altering unique keys or official financial totals",async()=>{
  const s=await seeded();
  try{
    const p={...plan,filters:january,group:"product" as const};
    const report=await queryNative(s.env,admin,p,s.m,s.version);
    const row=report.rows.find(r=>r.key==="P")!;
    assert.equal(row.name,"P — Suco Integral");assert.equal(row.description,"Suco Integral");
    assert.equal(row.values.revenue.current,265);
    assert.equal(report.total.values.gross.current,350);assert.equal(report.total.values.returns.current,1034);assert.equal(report.total.values.revenue.current,-684);
    assert.ok(report.warnings?.[0].includes("muitos-para-muitos"));
    const client=await queryNative(s.env,admin,{...p,group:"client"},s.m,s.version);
    assert.equal(client.rows.find(r=>r.key==="0001")?.name,"0001 — Mercado Exemplo");
  }finally{s.sql.close();}
});

test("ambiguous master descriptions are flagged instead of choosing an invented identity",async()=>{
  const s=await seeded();
  try{
    s.sql.prepare("INSERT INTO ci_raw_rows VALUES(?,?,?,?)").run(s.version,"products",3,JSON.stringify(["P","Descrição divergente"]));
    const labels=await nativeIdentityLabels(s.env,s.m,s.version,"product",["P"]);
    assert.deepEqual(labels.P,{name:"P",descriptionConflict:true});
    assert.deepEqual(await nativeIdentityLabels(s.env,s.m,s.version,"client",["unrequested"]),{});
  }finally{s.sql.close();}
});

test("description search is parameterized and applies the same scoped customer membership",async()=>{
  const s=await seeded();
  try{
    const scoped={...admin,role:"comercial" as const,national:0,clients:'["0001"]'};
    const found=await nativeSearch(s.env,scoped,january,s.m,s.version,"client","Mercado");
    assert.deepEqual(found.items,[{key:"0001",name:"0001 — Mercado Exemplo"}]);
    assert.deepEqual((await nativeSearch(s.env,scoped,january,s.m,s.version,"client","Reservado")).items,[]);
    assert.deepEqual((await nativeSearch(s.env,scoped,january,s.m,s.version,"client","' OR 1=1 --")).items,[]);
    assert.deepEqual((await nativeSearch(s.env,scoped,january,s.m,s.version,"client","%")).items,[]);
    assert.deepEqual((await nativeSearch(s.env,scoped,january,s.m,s.version,"category","C")).items,[{key:"C",name:"C"}]);
    const category=await queryNative(s.env,admin,{...plan,filters:{...january,category:"C"}},s.m,s.version);
    assert.equal(category.total.values.gross.current,300);assert.equal(category.total.values.revenue.current,265);
    await assert.rejects(()=>queryNative(s.env,{...scoped,role:"operador"},{...plan,filters:january},s.m,s.version),/operador/);
  }finally{s.sql.close();}
});

test("periods absent from snapshot coverage remain unavailable rather than synthetic zero",async()=>{
  const s=await seeded();
  try{
    const report=await queryNative(s.env,admin,{...plan,filters:{...january,from:"2027-01",to:"2027-01"}},s.m,s.version);
    assert.equal(report.total.values.revenue.current,null);assert.equal(report.total.values.returns.current,null);
    assert.equal(report.comparison?.status,"outside-coverage");
    assert.equal(report.rows[0].values.revenue.current,null);
  }finally{s.sql.close();}
});

test("actual monthly and total SQL excludes prior-year movements beyond the partial cutoff",async()=>{
  const s=await seeded();
  try{
    s.m.referenceDate="2026-01-02";s.m.projection.to="2026-01-02";
    await s.env.DB.batch([
      ...nativePartStatements(s.env,s.m,s.version,"s",[{row:5,values:["2025-01-20","0001","P","C","SP","São Paulo","100.0000"]}]),
      ...nativePartStatements(s.env,s.m,s.version,"d",[{row:5,values:["2025-01-20"]}]),
    ]);
    const report=await queryNative(s.env,admin,{...plan,filters:january},s.m,s.version);
    assert.equal(report.comparison?.previous.to,"2025-01-02");
    assert.equal(report.total.values.gross.previous,100);
    assert.equal(report.total.values.revenue.previous,90);
    assert.equal(report.rows[0].values.revenue.previous,90);
    assert.equal(report.total.values.revenue.current,-684);
  }finally{s.sql.close();}
});

test("daily customer activity uses document dates and the same customer and representative ACL",async()=>{
  const s=await seeded();
  try{
    const details=await nativeCustomerDetails(s.env,admin,{...january,client:"0001"},s.m,s.version);
    assert.equal(details.lastPurchase,"2026-01-02");assert.equal(details.purchaseDays,2);
    assert.equal(details.municipality,null);assert.match(details.limitations.join(" "),/não possui coluna de município/);
    const product=await nativeCustomerDetails(s.env,admin,{...january,client:"0001",product:"P"},s.m,s.version);
    assert.equal(product.lastPurchase,"2026-01-01");assert.equal(product.purchaseDays,1);
    await assert.rejects(()=>nativeCustomerDetails(s.env,{...admin,role:"comercial",national:0,clients:'["0002"]'},{...january,client:"0001"},s.m,s.version),/fora do seu escopo/);
    const noRepMatch=await nativeCustomerDetails(s.env,{...admin,role:"comercial",national:0,regions:'["Rep C"]'},{...january,client:"0001"},s.m,s.version);
    assert.equal(noRepMatch.lastPurchase,null);assert.equal(noRepMatch.purchaseDays,0);
    const unavailable=await nativeCustomerDetails(s.env,admin,{...january,from:"2027-01",to:"2027-01",client:"0001"},s.m,s.version);
    assert.equal(unavailable.lastPurchase,null);assert.equal(unavailable.purchaseDays,null);
  }finally{s.sql.close();}
});

test("municipality requires an actual customer column and a unique authorized value",async()=>{
  const s=await seeded();
  try{
    s.m.inventory.tables.find(t=>t.id==="c")!.columns.push({name:"Município",type:"String"});
    s.sql.prepare("UPDATE ci_raw_rows SET value=json_insert(value,'$[#]',?) WHERE version_id=? AND table_id='c'").run("Cidade Teste",s.version);
    assert.equal((await nativeCustomerDetails(s.env,admin,{...january,client:"0001"},s.m,s.version)).municipality,"Cidade Teste");
    s.sql.prepare("UPDATE ci_raw_rows SET value=json_set(value,'$[4]',?) WHERE version_id=? AND table_id='c' AND row_no=2").run("Outra Cidade",s.version);
    const conflict=await nativeCustomerDetails(s.env,admin,{...january,client:"0001"},s.m,s.version);
    assert.equal(conflict.municipality,null);assert.match(conflict.limitations.join(" "),/conflitantes/);
    const forbidden=await nativeCustomerDetails(s.env,{...admin,role:"comercial",national:0,regions:'["Rep C"]'},{...january,client:"0001"},s.m,s.version);
    assert.equal(forbidden.municipality,null);
  }finally{s.sql.close();}
});
