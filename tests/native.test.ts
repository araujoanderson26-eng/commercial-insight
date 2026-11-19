import test from "node:test";
import assert from "node:assert/strict";
import {manifestSchema,type ControlFilters} from "../shared/manual";
import type {DbUser} from "../worker/core";
import {dataStatus,manualContext,manualOptions,manualRoute,processManualJobs,processManualQueue,queryManual,type ManualJob} from "../worker/manual";
import {compileNativeGroups,nativeKey,nativePartStatements,nativeValues,queryNative,validateNativeModel} from "../worker/native-model";
import {makeStore,plan} from "./fixtures";
import {fakeR2} from "./manual-fixtures";
import {nativeFixture,nativeRows,type NativeRows} from "./native-fixtures";

const admin:DbUser={id:"native-admin",name:"Administrador teste",email:"native@example.test",role:"admin",password:"kept",regions:"[]",clients:"[]",national:1,active:1,entra_oid:null,scope_version:1,version:1};
const january:ControlFilters={from:"2026-01-01",to:"2026-01-31"};
async function seeded(rows:NativeRows=structuredClone(nativeRows)) {
  const s=makeStore(),pkg=nativeFixture(rows),version=crypto.randomUUID();
  s.sql.prepare("INSERT INTO ci_imports(id,owner,actor,filename,bytes,sha256,object_key,status,base_generation,created,updated,published,manifest) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(version,admin.id,admin.name,"native.ci.ndjson",pkg.data.length,pkg.sha256,"local", "published",0,1,1,1,JSON.stringify(pkg.manifest));
  s.sql.prepare("UPDATE ci_sources SET active_version_id=?,active_at=1 WHERE id='commercial-main'").run(version);
  for(const t of pkg.manifest.inventory.tables)await s.env.DB.batch(nativePartStatements(s.env,pkg.manifest,version,t.id,rows[t.id].map((values,i)=>({row:i+1,values}))));
  return {...s,...pkg,version};
}
const monthlyPlan={...plan,filters:{...plan.filters,from:"2026-01",to:"2026-01"}};

test("native recipe recognizer anchors exact DAX and the active filter graph",()=>{
  const m=manifestSchema.parse(nativeFixture().manifest);assert.doesNotThrow(()=>validateNativeModel(m));
  for(const changed of [
    (x:typeof m)=>{x.nativeModel!.recipes.buyers.dax="CALCULATE(DISTINCTCOUNT(Faturamento[Codigo Cliente]),YEAR(dCalendario[Date])=2026)";},
    (x:typeof m)=>{x.inventory.relationships.push({fromTable:"r",fromColumn:"Produto",toTable:"s",toColumn:"Produto",fromCardinality:"Many",toCardinality:"Many",isActive:true,crossFilteringBehavior:"BothDirections"});},
    (x:typeof m)=>{(x.inventory.relationships[2] as {crossFilteringBehavior:string}).crossFilteringBehavior="OneDirection";},
  ]){const copy=structuredClone(m);changed(copy);assert.throws(()=>validateNativeModel(copy));}
  assert.equal(nativeKey("ação  "),"AÇÃO");assert.equal(nativeKey(""),null);assert.throws(()=>nativeKey("Straße"),/collation/);
});

test("native sums independent facts and evaluates returns through customer membership",async()=>{
  const s=await seeded();
  const [total,rep,product,noSales]=await nativeValues(s.env,s.version,[january,{...january,region:"rep a "},{...january,product:"P"},{from:"2026-02-01",to:"2026-02-28"}]);
  assert.deepEqual([total.gross,total.returns,total.revenue,total.buyers,total.records],[3500000,10340000,-6840000,2,3]);
  assert.deepEqual([rep.gross,rep.returns,rep.revenue,rep.buyers],[1500000,150000,1350000,1]);
  assert.deepEqual([product.gross,product.returns,product.revenue],[3000000,350000,2650000]);
  assert.deepEqual([noSales.gross,noSales.returns,noSales.revenue,noSales.buyers],[null,70000,-70000,null]);
  const [whole]=await nativeValues(s.env,s.version,[{from:"2025-01-01",to:"2026-02-01"}]);assert.equal(whole.buyers,2);assert.equal(whole.revenue,-6010000);
  s.sql.close();
});

test("group context preserves many-to-many overlaps and nonadditive return totals",async()=>{
  const s=await seeded();
  const product=await queryNative(s.env,admin,{...monthlyPlan,group:"product"},s.manifest,s.version);
  assert.equal(product.total.values.revenue.current,-684);
  assert.deepEqual(product.rows.map(r=>[r.name,r.values.gross.current,r.values.returns.current,r.values.revenue.current]),[["P",300,35,265],["Q",50,15,35]]);
  const reps=await queryNative(s.env,admin,{...monthlyPlan,group:"region"},s.manifest,s.version);
  assert.deepEqual(reps.rows.map(r=>[r.name,r.values.gross.current,r.values.returns.current]),[["Rep B",350,35],["Rep A",150,15],["Rep C",null,999]]);
  assert.equal(reps.total.values.gross.current,350);assert.equal(reps.total.values.gross.previous,100);
  const regional=await queryNative(s.env,admin,{...monthlyPlan,group:"regional"},s.manifest,s.version);
  assert.deepEqual(regional.rows.map(r=>[r.name,r.values.revenue.current]),[["Norte",180],["Sudeste",-864]]);
  const manager=await queryNative(s.env,admin,{...monthlyPlan,group:"manager"},s.manifest,s.version);
  assert.deepEqual(manager.rows.map(r=>[r.name,r.values.revenue.current]),[["G2",180],["G1",-864]]);
  s.sql.close();
});

test("native BLANK keys match explicit BLANK and DISTINCTCOUNT counts one BLANK",async()=>{
  const rows=structuredClone(nativeRows);rows.s.push(["2026-01-01",null,"P","C","SP","São Paulo","5"]);rows.c.push([null,"Rep A","SP"]);rows.r.push(["2026-01-01",null,"Q","D","SP","4"]);
  const s=await seeded(rows),[result]=await nativeValues(s.env,s.version,[january]);
  assert.deepEqual([result.gross,result.returns,result.revenue,result.buyers],[3550000,10380000,-6830000,3]);
  const grouped=await queryNative(s.env,admin,{...monthlyPlan,group:"client"},s.manifest,s.version);
  const blank=grouped.rows.find(r=>r.name==="(Em branco)");assert(blank);assert.equal(blank.values.revenue.current,1);assert.equal(blank.values.buyers.current,1);assert.equal(blank.canDrill,false);
  s.sql.close();
});

test("exact duplicate facts survive while duplicate dimension matches never multiply amounts",async()=>{
  const rows=structuredClone(nativeRows);rows.s.push([...rows.s[1]]);rows.c.push([...rows.c[0]]);rows.l.push(["SP"]);rows.a.push(["SP"]);rows.m.push(["São Paulo"]);
  const s=await seeded(rows),[result]=await nativeValues(s.env,s.version,[january]);assert.equal(result.gross,4500000);assert.equal(result.returns,10340000);
  await s.env.DB.batch(nativePartStatements(s.env,s.manifest,s.version,"s",rows.s.map((values,i)=>({row:i+1,values}))));assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM ci_native_sales").get()?.n,5);
  const q=compileNativeGroups(s.version,[january],"region"),groups=(await s.env.DB.prepare(q.sql).bind(...q.args).all<{name:string;gross:number}>()).results;
  assert.equal(groups.find(r=>r.name==="Rep A")?.gross,2500000);s.sql.close();
});

test("security intersects representative and client scopes before groups and available options",async()=>{
  const s=await seeded(),limited={...admin,role:"gerente" as const,national:0,regions:'["Rep A"]',clients:'["0001"]'};
  const report=await queryNative(s.env,limited,{...monthlyPlan,group:"region"},s.manifest,s.version);assert.deepEqual(report.rows.map(r=>r.name),["Rep A"]);assert.equal(report.total.values.revenue.current,135);
  const options=await manualOptions(s.env,limited,monthlyPlan.filters);assert.deepEqual(options.values.region,["Rep A"]);assert.deepEqual(options.values.client,["0001"]);assert.deepEqual(options.values.regional,["Sudeste"]);
  await assert.rejects(()=>queryNative(s.env,limited,{...monthlyPlan,filters:{...monthlyPlan.filters,region:"Rep B"}},s.manifest,s.version),/fora do seu escopo/);
  const disjoint={...limited,clients:'["0002"]'},empty=await queryNative(s.env,disjoint,monthlyPlan,s.manifest,s.version);assert.equal(empty.total.values.gross.current,null);assert.equal(empty.total.values.revenue.current,0);
  s.sql.close();
});

test("native ingestion preserves money scale and rejects nonmidnight dates without truncation",async()=>{
  const rows=structuredClone(nativeRows);rows.s[1][6]="100.1234";const s=await seeded(rows),[result]=await nativeValues(s.env,s.version,[january]);assert.equal(result.gross,3501234);
  assert.throws(()=>nativePartStatements(s.env,s.manifest,s.version,"s",[{row:90,values:["2026-01-01T01:00:00.0000000","0001","P","C","SP","São Paulo","1"]}]),/horário não nulo/);
  assert.throws(()=>nativePartStatements(s.env,s.manifest,s.version,"s",[{row:90,values:["2026-01-01","0001","P","C","SP","São Paulo","1.12345"]}]),/escala/);s.sql.close();
});

test("DAX filter origins preserve unfiltered orphans and distinguish calendar from an explicit Sales cohort",async()=>{
  const rows=structuredClone(nativeRows);rows.s.push(["2026-01-01","orphan","P","C","XX","Absent municipality","25"]);rows.r.push(["2026-01-01","orphan","Q","D","XX","3"]);rows.s.push(["2025-01-01","0003","P","C","SP","São Paulo","20"]);
  const s=await seeded(rows),[date,product,rep,uf,geo]=await nativeValues(s.env,s.version,[january,{...january,product:"P"},{...january,region:"Rep C"},{...january,state:"SP"},{...january,regional:"Sudeste"}]);
  assert.deepEqual([date.gross,date.returns],[3750000,10370000]);
  assert.equal(date.buyers,3);
  assert.deepEqual([product.gross,product.returns],[3250000,350000]);
  assert.deepEqual([rep.gross,rep.returns],[null,9990000]);
  assert.deepEqual([uf.gross,uf.returns],[1500000,150000]);
  assert.deepEqual([geo.gross,geo.returns],[1500000,10140000]);
  const grouped=await queryNative(s.env,admin,{...monthlyPlan,group:"regional"},s.manifest,s.version),blank=grouped.rows.find(r=>r.name==="(Em branco)");assert(blank);assert.equal(blank.values.gross.current,25);assert.equal(blank.values.returns.current,3);assert.equal(blank.canDrill,false);
  s.sql.close();
});

test("v2 imports a thousand-row part atomically while v1 remains capped at one hundred",async()=>{
  const rows=structuredClone(nativeRows);rows.s=Array.from({length:1000},()=>["2026-01-01","0001","P","C","SP","São Paulo","1"]);
  const s=makeStore(),r2=fakeR2(),pkg=nativeFixture(rows),id=crypto.randomUUID(),key="local/large-native";
  assert.equal(manifestSchema.parse(pkg.manifest).inventory.tables[0].parts[0].rows,1000);
  const legacy=structuredClone(pkg.manifest);legacy.formatVersion=1;delete legacy.nativeModel;legacy.projection.parts=[{index:1,rows:100,bytes:100,sha256:"a".repeat(64)}];assert.equal(manifestSchema.safeParse(legacy).success,false);
  Object.assign(s.env,{BUCKET:r2.bucket,MANUAL_ALLOW_SYNTHETIC:"true"});r2.objects.set(key,pkg.data);
  s.sql.prepare("INSERT INTO ci_imports(id,owner,actor,filename,bytes,sha256,object_key,status,base_generation,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(id,admin.id,admin.name,"thousand.ci.ndjson",pkg.data.length,pkg.sha256,key,"queued",0,1,1);
  s.sql.prepare("UPDATE ci_sources SET latest_import_id=?").run(id);await processManualJobs(s.env);
  assert.equal(s.sql.prepare("SELECT status FROM ci_imports WHERE id=?").get(id)?.status,"validating");
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM ci_native_sales WHERE version_id=?").get(id)?.n,1000);assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM ci_raw_rows WHERE version_id=? AND table_id='s'").get(id)?.n,1000);
  const [result]=await nativeValues(s.env,id,[january]);assert.equal(result.gross,10000000);assert.equal(result.buyers,1);
  s.sql.close();
});

test("v2 package lifecycle reconciles 36 DAX controls and keeps every raw row and metadata table",async()=>{
  const s=makeStore(),r2=fakeR2(),pkg=nativeFixture();Object.assign(s.env,{BUCKET:r2.bucket,MANUAL_ALLOW_SYNTHETIC:"true"});
  const call=async(path:string,method="GET",value?:unknown)=>{const response=await manualRoute(new Request("https://example.test/api"+path,{method,headers:value instanceof Uint8Array?{"content-length":String(value.length)}:{"content-type":"application/json"},body:value===undefined?undefined:value instanceof Uint8Array?value:JSON.stringify(value)}),s.env,admin,path);assert(response);return response;};
  const created=await (await call("/admin/data/imports","POST",{filename:"native.ci.ndjson",bytes:pkg.data.length,sha256:pkg.sha256})).json() as {id:string};
  await call("/admin/data/imports/"+created.id+"/parts/1","PUT",pkg.data);await call("/admin/data/imports/"+created.id+"/complete","POST",{});
  for(let i=0;i<35;i++)await processManualJobs(s.env);
  const row=s.sql.prepare("SELECT status,error,report FROM ci_imports WHERE id=?").get(created.id)!;assert.equal(row.status,"published",String(row.error));
  const validation=JSON.parse(String(row.report));assert.equal(validation.controls.length,36);assert(validation.controls.every((c:{passed:boolean})=>c.passed));
  assert.equal((await dataStatus(s.env)).active?.tables,9);assert.equal((await manualContext(s.env)).capabilities?.labels?.region,"Representante");
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM ci_facts").get()?.n,0);assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM ci_raw_rows").get()?.n,Object.values(nativeRows).reduce((n,r)=>n+r.length,0));
  const result=await queryManual(s.env,admin,monthlyPlan);assert.equal(result.total.values.revenue.current,-684);assert.equal(result.sourceInfo?.capabilities?.labels?.revenue,"Faturamento líquido");
  s.sql.close();
});

test("queue acceleration honors leases, duplicate deliveries and cron recovery",async()=>{
  const s=makeStore(),r2=fakeR2(),pkg=nativeFixture(),sent:{body:ManualJob;delay:number}[]=[];let unavailable=true;
  Object.assign(s.env,{BUCKET:r2.bucket,MANUAL_ALLOW_SYNTHETIC:"true",MANUAL_JOBS:{async send(body:ManualJob,options:{delaySeconds:number}){if(unavailable)throw Error("Temporary queue outage");sent.push({body,delay:options.delaySeconds});}}});
  const call=async(path:string,method:string,value:unknown)=>{const response=await manualRoute(new Request("https://example.test/api"+path,{method,headers:value instanceof Uint8Array?{"content-length":String(value.length)}:{"content-type":"application/json"},body:value instanceof Uint8Array?value:JSON.stringify(value)}),s.env,admin,path);assert(response);return response;};
  const created=await (await call("/admin/data/imports","POST",{filename:"queue-native.ci.ndjson",bytes:pkg.data.length,sha256:pkg.sha256})).json() as {id:string};
  await call("/admin/data/imports/"+created.id+"/parts/1","PUT",pkg.data);await call("/admin/data/imports/"+created.id+"/complete","POST",{});
  assert.equal(s.sql.prepare("SELECT status FROM ci_imports WHERE id=?").get(created.id)?.status,"queued");assert.equal(sent.length,0);
  unavailable=false;
  const originalBatch=s.env.DB.batch.bind(s.env.DB);let interrupted=false;
  s.env.DB.batch=(async(statements:D1PreparedStatement[])=>{const result=await originalBatch(statements);if(!interrupted){interrupted=true;throw Error("D1_ERROR: request timed out after checkpoint commit");}return result;}) as D1Database["batch"];
  await processManualJobs(s.env);s.env.DB.batch=originalBatch;
  assert.equal(interrupted,true);assert.notEqual(s.sql.prepare("SELECT status FROM ci_imports WHERE id=?").get(created.id)?.status,"failed");assert.equal(sent.at(-1)!.delay,30);
  assert(sent.length>0);assert.deepEqual(Object.keys(sent[0].body),["jobId"]);
  let acknowledged=0,retries=0;
  const deliver=async(body:unknown)=>processManualQueue({messages:[{body,ack(){acknowledged++;},retry(){retries++;}}]} as unknown as MessageBatch<ManualJob>,s.env);
  s.sql.prepare("UPDATE ci_imports SET lease_until=? WHERE id=?").run(Math.floor(Date.now()/1000)+60,created.id);
  await deliver({jobId:created.id});assert(sent.at(-1)!.delay>=60);assert.equal(acknowledged,1);
  s.sql.prepare("UPDATE ci_imports SET lease_until=0 WHERE id=?").run(created.id);
  for(let i=0;i<35&&sent.length;i++)await deliver(sent.shift()!.body);
  assert.equal((await dataStatus(s.env)).active?.id,created.id);const before=s.sql.prepare("SELECT COUNT(*) n FROM ci_native_sales").get()?.n;
  await deliver({jobId:created.id});await deliver({jobId:created.id,unexpected:"ignored poison"});assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM ci_native_sales").get()?.n,before);assert.equal(retries,0);
  s.sql.close();
});

test("v2 continuity accepts unused inventory columns and keeps the full raw inventory",async()=>{
  const s=makeStore(),r2=fakeR2();Object.assign(s.env,{BUCKET:r2.bucket,MANUAL_ALLOW_SYNTHETIC:"true"});
  const publish=async(pkg:ReturnType<typeof nativeFixture>)=>{
    const id=crypto.randomUUID(),key="local/"+id;r2.objects.set(key,pkg.data);
    s.sql.prepare("INSERT INTO ci_imports(id,owner,actor,filename,bytes,sha256,object_key,status,base_generation,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(id,admin.id,admin.name,"continuity.ci.ndjson",pkg.data.length,pkg.sha256,key,"queued",Number(s.sql.prepare("SELECT generation FROM ci_sources").get()!.generation),1,1);
    s.sql.prepare("UPDATE ci_sources SET latest_import_id=?").run(id);for(let i=0;i<35;i++)await processManualJobs(s.env);return id;
  };
  const first=await publish(nativeFixture());assert.equal((await dataStatus(s.env)).active?.id,first);
  const rows=structuredClone(nativeRows);rows.s=rows.s.map(row=>[...row,"audit-only"]);
  const second=await publish(nativeFixture(rows,m=>{m.inventory.tables.find(t=>t.id==="s")!.columns.push({name:"Unused audit column",type:"String"});}));
  assert.equal((await dataStatus(s.env)).active?.id,second,String(s.sql.prepare("SELECT error FROM ci_imports WHERE id=?").get(second)?.error));
  assert.match(String(s.sql.prepare("SELECT value FROM ci_raw_rows WHERE version_id=? AND table_id='s' LIMIT 1").get(second)?.value),/audit-only/);
  const third=await publish(nativeFixture(rows,m=>{
    m.inventory.tables.find(t=>t.id==="s")!.columns.push({name:"Unused audit column",type:"String"});
    const expression="\n sum ( 'Faturamento' [Valor mercadorias] ) \n";
    m.nativeModel!.recipes.gross.dax=expression;m.metrics.find(x=>x.id==="gross")!.dax=expression;
    (m.inventory.measures.find(x=>typeof x==="object"&&x!==null&&"name"in x&&x.name==="Fat. Bruto") as {expression:string}).expression=expression;
  }));
  assert.equal((await dataStatus(s.env)).active?.id,third,String(s.sql.prepare("SELECT error FROM ci_imports WHERE id=?").get(third)?.error));
  s.sql.close();
});
