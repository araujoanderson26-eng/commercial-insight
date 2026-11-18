import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {decimalInteger,UPLOAD_PART_BYTES} from "../shared/manual";
import {dataStatus,manualRoute,processManualJobs,queryManual} from "../worker/manual";
import type {DbUser,Env} from "../worker/core";
import {makeStore,plan} from "./fixtures";
import {fixturePackage,fakeR2,testFacts,bytes,hash} from "./manual-fixtures";
const admin:DbUser={id:"administrator",name:"Administrador teste",email:"admin@example.test",role:"admin",password:"unchanged-hash",regions:"[]",clients:"[]",national:1,active:1,entra_oid:null,scope_version:1,version:1};
function store() {
  const result=makeStore();
  const exists=result.sql.prepare("SELECT name FROM sqlite_master WHERE name='ci_sources'").get();
  if(!exists)result.sql.exec(readFileSync(new URL("../migrations/0003_manual_data.sql",import.meta.url),"utf8"));
  const r2=fakeR2();Object.assign(result.env,{BUCKET:r2.bucket,MANUAL_ALLOW_SYNTHETIC:"true"});
  result.sql.prepare("INSERT INTO users(id,email,name,password,role,created) VALUES(?,?,?,?,?,?)").run(admin.id,admin.email,admin.name,admin.password,admin.role,1);
  return {...result,...r2};
}
async function call(env:Env,path:string,method="GET",value?:unknown,user=admin) {
  const response=await manualRoute(new Request("https://example.test/api"+path,{method,headers:value instanceof Uint8Array?{"content-type":"application/octet-stream","content-length":String(value.length)}:{"content-type":"application/json"},body:value===undefined?undefined:value instanceof Uint8Array?value:JSON.stringify(value)}),env,user,path);
  assert(response);return response;
}
async function upload(env:Env,pkg:ReturnType<typeof fixturePackage>,complete=true) {
  const created=await (await call(env,"/admin/data/imports","POST",{filename:"teste.ci.ndjson",bytes:pkg.data.length,sha256:pkg.sha256})).json() as {id:string;existing?:boolean};
  if(!created.existing) {
    for(let offset=0,part=1;offset<pkg.data.length;offset+=UPLOAD_PART_BYTES,part++)await call(env,"/admin/data/imports/"+created.id+"/parts/"+part,"PUT",pkg.data.slice(offset,offset+UPLOAD_PART_BYTES));
    if(complete)await call(env,"/admin/data/imports/"+created.id+"/complete","POST",{});
  }
  return created.id;
}
async function process(env:Env){for(let i=0;i<30;i++)await processManualJobs(env);}

test("fixed decimals preserve zeros, signs, scale and reject silent precision loss",()=>{
  assert.equal(decimalInteger("1.20",2),120);assert.equal(decimalInteger("-1.2000",2),-120);assert.equal(decimalInteger("0.000001",6),1);
  assert.throws(()=>decimalInteger("0001",2));assert.throws(()=>decimalInteger("1.201",2));assert.throws(()=>decimalInteger("1e4",2));assert.throws(()=>decimalInteger("9007199254740992",0));
});

test("valid synthetic package publishes only after all DAX controls, preserves login",async()=>{
  const s=store(),id=await upload(s.env,fixturePackage());
  assert.equal((await dataStatus(s.env)).active,null);
  await process(s.env);
  const status=await dataStatus(s.env);assert.equal(status.active?.id,id);assert.equal(status.active?.rows,4);assert.equal(status.active?.projectionRows,4);assert.equal(status.active?.processedRows,8);
  const report=await queryManual(s.env,admin,{...plan,filters:{...plan.filters,from:"2026-01",to:"2026-01"}});
  assert.equal(report.total.values.revenue.current,70);assert.equal(report.total.values.revenue.previous,30);
  assert.equal(report.sourceInfo?.versionId,id);
  assert.equal(s.sql.prepare("SELECT password FROM users WHERE id=?").get(admin.id)?.password,admin.password);
  assert.equal((s.sql.prepare("SELECT report FROM ci_imports WHERE id=?").get(id)!.report as string).includes('"passed":true'),true);
  s.sql.close();
});

test("full replacement removes absent facts, repeat file and repeat batch never duplicates, rollback restores",async()=>{
  const s=store(),firstPackage=fixturePackage(),first=await upload(s.env,firstPackage);await process(s.env);
  const second=await upload(s.env,fixturePackage(testFacts.filter(f=>f.row!==4)));await process(s.env);
  assert.equal((await dataStatus(s.env)).active?.id,second);
  assert.equal((await queryManual(s.env,admin,{...plan,filters:{...plan.filters,from:"2026-01",to:"2026-01"}})).total.values.revenue.current,30);
  assert.equal(await upload(s.env,firstPackage),first);
  assert.equal(s.sql.prepare("SELECT COUNT(*) AS n FROM ci_facts WHERE version_id=?").get(first)?.n,4);
  await call(s.env,"/admin/data/restore","POST",{versionId:first,expectedActiveVersionId:second});
  assert.equal((await queryManual(s.env,admin,{...plan,filters:{...plan.filters,from:"2026-01",to:"2026-01"}})).total.values.revenue.current,70);
  s.sql.close();
});

test("incomplete checksum and divergent KPI never replace the active version",async()=>{
  const s=store(),first=await upload(s.env,fixturePackage());await process(s.env);
  const bad=fixturePackage(testFacts,m=>{m.controls[0].expected="999";});
  const second=await upload(s.env,bad);await process(s.env);
  assert.equal((await dataStatus(s.env)).active?.id,first);
  assert.equal(s.sql.prepare("SELECT status FROM ci_imports WHERE id=?").get(second)?.status,"failed");
  const corrupt=fixturePackage(testFacts,m=>{m.projection.parts[0].sha256="f".repeat(64);});
  const third=await upload(s.env,corrupt);await process(s.env);
  assert.equal(s.sql.prepare("SELECT status FROM ci_imports WHERE id=?").get(third)?.status,"failed");
  assert.equal((await dataStatus(s.env)).active?.id,first);
  s.sql.close();
});

test("newest submitted snapshot has precedence and stale imports cannot publish",async()=>{
  const s=store(),first=await upload(s.env,fixturePackage());
  const second=await upload(s.env,fixturePackage(testFacts.filter(f=>f.row!==4)));
  await process(s.env);
  assert.equal((await dataStatus(s.env)).active?.id,second);
  assert.equal(s.sql.prepare("SELECT status FROM ci_imports WHERE id=?").get(first)?.status,"superseded");
  s.sql.close();
});

test("retrying a persisted import resumes idempotently and cancellation leaves active valid",async()=>{
  const s=store(),first=await upload(s.env,fixturePackage());await process(s.env);
  const second=await upload(s.env,fixturePackage(testFacts.filter(f=>f.row!==4)));
  await call(s.env,"/admin/data/imports/"+second+"/cancel","POST",{});await process(s.env);
  assert.equal((await dataStatus(s.env)).active?.id,first);
  await call(s.env,"/admin/data/imports/"+second+"/retry","POST",{});await process(s.env);
  assert.equal((await dataStatus(s.env)).active?.id,second);
  assert.equal(s.sql.prepare("SELECT COUNT(*) AS n FROM ci_facts WHERE version_id=?").get(second)?.n,3);
  // Simulate crash immediately after the atomic checkpoint: replay has no effect.
  s.sql.prepare("UPDATE ci_imports SET status='importing',part_cursor=0,processed_bytes=?,rows=0,published=NULL,base_generation=99 WHERE id=?").run(bytes(JSON.stringify(fixturePackage(testFacts.filter(f=>f.row!==4)).manifest)+"\n").length,second);
  await process(s.env);
  assert.equal(s.sql.prepare("SELECT COUNT(*) AS n FROM ci_facts WHERE version_id=?").get(second)?.n,3);
  s.sql.close();
});

test("synthetic data rejected without local flag, every admin mutation rejects ordinary user",async()=>{
  const s=store();delete (s.env as Env&{MANUAL_ALLOW_SYNTHETIC?:string}).MANUAL_ALLOW_SYNTHETIC;
  const id=await upload(s.env,fixturePackage());await process(s.env);
  assert.equal(s.sql.prepare("SELECT status FROM ci_imports WHERE id=?").get(id)?.status,"failed");
  const limited={...admin,role:"comercial" as const,national:0,regions:'["Sul"]'};
  await assert.rejects(()=>call(s.env,"/admin/data","GET",undefined,limited),/exclusivo/);
  s.sql.close();
});

test("complete upload recovers if R2 finished before D1 queued checkpoint",async()=>{
  const s=store(),pkg=fixturePackage(),id=await upload(s.env,pkg,false);
  const row=s.sql.prepare("SELECT object_key,upload_id FROM ci_imports WHERE id=?").get(id)!;
  const parts=s.sql.prepare("SELECT part AS partNumber,etag FROM ci_upload_parts WHERE import_id=?").all(id);
  await s.bucket.resumeMultipartUpload(String(row.object_key),String(row.upload_id)).complete(parts as unknown as R2UploadedPart[]);
  await call(s.env,"/admin/data/imports/"+id+"/complete","POST",{});await process(s.env);
  assert.equal((await dataStatus(s.env)).active?.id,id);s.sql.close();
});

test("declared duplicate keys and missing relationship targets block publication",async()=>{
  const s=store();
  const duplicate=fixturePackage(testFacts,m=>{m.inventory.tables[0].columns[2].isKey=true;});
  const id=await upload(s.env,duplicate);await process(s.env);
  const result=s.sql.prepare("SELECT status,error FROM ci_imports WHERE id=?").get(id)!;
  assert.equal(result.status,"failed");assert.match(String(result.error),/chave declarada duplicada/);
  assert.equal((await dataStatus(s.env)).active,null);
  const missing=fixturePackage(testFacts,m=>{m.inventory.relationships=[{fromTable:"f",fromColumn:"client",toTable:"missing",toColumn:"id",fromCardinality:"Many",toCardinality:"One"}];});
  const second=await upload(s.env,missing);await process(s.env);
  assert.equal(s.sql.prepare("SELECT status FROM ci_imports WHERE id=?").get(second)?.status,"failed");s.sql.close();
});

test("capacity preflight rejects before any commercial rows are loaded",async()=>{
  const s=store();Object.assign(s.env,{MANUAL_D1_CAPACITY_BYTES:"100"});
  const id=await upload(s.env,fixturePackage());await process(s.env);
  assert.equal(s.sql.prepare("SELECT status FROM ci_imports WHERE id=?").get(id)?.status,"failed");
  assert.equal(s.sql.prepare("SELECT COUNT(*) AS n FROM ci_raw_rows").get()?.n,0);
  assert.equal(s.sql.prepare("SELECT COUNT(*) AS n FROM ci_facts").get()?.n,0);s.sql.close();
});

test("truncated package and invalid dates preserve the valid active snapshot",async()=>{
  const s=store(),first=await upload(s.env,fixturePackage());await process(s.env);
  const pkg=fixturePackage(testFacts.filter(f=>f.row!==4));
  pkg.data=pkg.data.slice(0,-1);pkg.sha256=hash(pkg.data);
  const truncated=await upload(s.env,pkg);await process(s.env);
  assert.equal(s.sql.prepare("SELECT status FROM ci_imports WHERE id=?").get(truncated)?.status,"failed");
  const invalid=fixturePackage(testFacts,m=>{m.projection.to="2026-13-01";});
  const invalidId=await upload(s.env,invalid);await process(s.env);
  assert.equal(s.sql.prepare("SELECT status FROM ci_imports WHERE id=?").get(invalidId)?.status,"failed");
  assert.equal((await dataStatus(s.env)).active?.id,first);s.sql.close();
});


test("multipart upload crosses 5 MiB, replacing a repeated part never inflates progress",async()=>{
  const s=store(),data=new Uint8Array(UPLOAD_PART_BYTES+256).fill(120);
  const pkg={...fixturePackage(),data,sha256:hash(data)};
  const id=await upload(s.env,pkg,false);
  assert.equal(s.sql.prepare("SELECT COUNT(*) AS n FROM ci_upload_parts WHERE import_id=?").get(id)?.n,2);
  await call(s.env,"/admin/data/imports/"+id+"/parts/1","PUT",data.slice(0,UPLOAD_PART_BYTES));
  assert.equal(s.sql.prepare("SELECT uploaded_bytes FROM ci_imports WHERE id=?").get(id)?.uploaded_bytes,data.length);
  const duplicate=await (await call(s.env,"/admin/data/imports","POST",{filename:"teste.ci.ndjson",bytes:data.length,sha256:pkg.sha256})).json() as {id:string;existing:boolean;uploadedParts:unknown[]};
  assert.equal(duplicate.id,id);assert.equal(duplicate.existing,true);assert.equal(duplicate.uploadedParts.length,2);
  await call(s.env,"/admin/data/imports/"+id+"/complete","POST",{});
  const key=String(s.sql.prepare("SELECT object_key FROM ci_imports WHERE id=?").get(id)?.object_key);
  assert.equal(s.objects.get(key)?.length,data.length);s.sql.close();
});
