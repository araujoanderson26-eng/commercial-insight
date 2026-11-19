import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/index";
import { digest } from "../worker/core";
import { makeStore, plan } from "./fixtures";
import { fakeR2 } from "./manual-fixtures";
import { nativeFixture, nativeRows } from "./native-fixtures";
import { nativePartStatements } from "../worker/native-model";

async function setup() {
  const store = makeStore(), pkg = nativeFixture(), version = crypto.randomUUID();
  store.env.BUCKET = fakeR2().bucket;
  store.sql.prepare("INSERT INTO ci_imports(id,owner,actor,filename,bytes,sha256,object_key,status,base_generation,created,updated,published,manifest) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(version,"admin","Teste sintético","synthetic.ci.ndjson",pkg.data.length,pkg.sha256,"local","published",0,1,1,1,JSON.stringify(pkg.manifest));
  store.sql.prepare("UPDATE ci_sources SET source='manual',active_version_id=?,active_at=1,allow_ai=0").run(version);
  for (const table of pkg.manifest.inventory.tables) await store.env.DB.batch(nativePartStatements(store.env,pkg.manifest,version,table.id,nativeRows[table.id].map((values,i)=>({row:i+1,values}))));
  const cookies:Record<string,string>={};
  for (const [id,role,clients,operator] of [["admin","admin","[]",0],["sales","comercial",'["0001"]',0],["other","comercial",'["0002"]',0],["operator","comercial","[]",1]] as const) {
    store.sql.prepare("INSERT INTO users(id,email,name,password,role,clients,update_only,created) VALUES(?,?,?,?,?,?,?,unixepoch())").run(id,id+"@synthetic.test",id,"unused-test-hash",role,clients,operator);
    const raw = crypto.randomUUID().replaceAll("-","").repeat(2);
    store.sql.prepare("INSERT INTO sessions(hash,user_id,version,expires,seen) VALUES(?,?,1,unixepoch()+3600,unixepoch())").run(await digest(raw),id);
    cookies[id]="__Host-ci="+raw;
  }
  async function request(path:string,method="GET",value?:unknown,actor="admin") {
    return worker.fetch(new Request(store.env.APP_ORIGIN+"/api/"+path,{method,headers:{Origin:store.env.APP_ORIGIN,Cookie:cookies[actor]??"","Content-Type":"application/json"},body:value===undefined?undefined:JSON.stringify(value)}),store.env,{waitUntil() {}} as unknown as ExecutionContext);
  }
  return {...store,request,version};
}
const january={...plan,filters:{...plan.filters,from:"2026-01",to:"2026-01"}};

test("update operator can submit own packages but cannot query, administer, restore or download raw commercial data",async t=>{
  const s=await setup();t.after(()=>s.sql.close());
  const me=await (await s.request("me","GET",undefined,"operator")).json() as {user:{role:string}};
  assert.equal(me.user.role,"operador");
  assert.equal((await s.request("admin/data","GET",undefined,"operator")).status,200);
  for(const [path,method,value]of [["report","POST",january],["visit","POST",{...january.filters,client:"0001"}],["chat","POST",{question:"Como estamos?",filters:january.filters,conversation:null}],["data/options","POST",january.filters],["data/search","POST",{filters:january.filters,dimension:"client",query:"0001"}],["saved-reports","GET",undefined],["admin/users","GET",undefined],["admin/data/settings","PUT",{source:"manual",allowAI:true,staleDays:7}],["admin/data/restore","POST",{versionId:s.version,expectedActiveVersionId:s.version}],[`admin/data/imports/${s.version}/package`,"GET",undefined]] as const) {
    assert.equal((await s.request(path,method,value,"operator")).status,403,path);
  }
  const init=await s.request("admin/data/imports","POST",{filename:"SINTETICO.ci.ndjson",bytes:100,sha256:"a".repeat(64)},"operator");
  assert.equal(init.status,201);
  const upload=await init.json() as {id:string};
  assert.equal((await s.request(`admin/data/imports/${upload.id}/cancel`,"POST",{},"operator")).status,200);
  assert.equal((await s.request(`admin/data/imports/${s.version}/cancel`,"POST",{},"operator")).status,403);
});

test("saved reports validate current ACL, isolate owners and disappear after scope revocation",async t=>{
  const s=await setup();t.after(()=>s.sql.close());
  assert.equal((await s.request("saved-reports","POST",{title:"Fora da carteira",plan:{...january,filters:{...january.filters,client:"0002"}}},"sales")).status,403);
  const created=await s.request("saved-reports","POST",{title:"Carteira autorizada",plan:january,question:"Como estamos?"},"sales");
  assert.equal(created.status,201);
  const saved=await created.json() as {id:string};
  assert.equal((await (await s.request("saved-reports","GET",undefined,"sales")).json() as unknown[]).length,1);
  assert.deepEqual(await (await s.request("saved-reports","GET",undefined,"other")).json(),[]);
  assert.equal((await s.request("saved-reports/"+saved.id,"DELETE",undefined,"other")).status,404);
  s.sql.prepare("UPDATE users SET scope_version=scope_version+1 WHERE id='sales'").run();
  assert.deepEqual(await (await s.request("saved-reports","GET",undefined,"sales")).json(),[]);
  assert.equal((await s.request("saved-reports/"+saved.id,"DELETE",undefined,"sales")).status,404);
});

test("visits remain useful without OpenAI and reject a client outside the authorized portfolio",async t=>{
  const s=await setup();t.after(()=>s.sql.close());delete s.env.OPENAI_API_KEY;
  const status=await (await s.request("assistant/status")).json() as {ready:boolean;pending:string[]};
  assert.equal(status.ready,false);assert.deepEqual(status.pending,["source_disabled","credential_missing"]);
  assert.equal((await s.request("visit","POST",{...january.filters,client:"0002"},"sales")).status,403);
  const response=await s.request("visit","POST",{...january.filters,client:"0001"},"sales");
  assert.equal(response.status,200);
  const briefing=await response.json() as {client:{code:string};timeline:{total:{values:{revenue:{current:number}}}};limitations:string[]};
  assert.equal(briefing.client.code,"0001");assert.equal(briefing.timeline.total.values.revenue.current,135);
  assert.ok(briefing.limitations.length>0);
});

test("administrator can assign update-only profile without replacing the original users table",async t=>{
  const s=await setup();t.after(()=>s.sql.close());
  const result=await s.request("admin/users","POST",{user:{name:"Operador sintético",email:"new-operator@synthetic.test",role:"operador",national:false,active:true,regions:[],clients:[],entraOid:null},password:"Senha sintética exclusiva 123"});
  assert.equal(result.status,200);
  const id=(await result.json() as {id:string}).id;
  assert.deepEqual({...s.sql.prepare("SELECT role,update_only FROM users WHERE id=?").get(id)},{role:"comercial",update_only:1});
  const listed=await (await s.request("admin/users")).json() as {id:string;role:string}[];
  assert.equal(listed.find(user=>user.id===id)?.role,"operador");
  assert.equal(s.sql.prepare("SELECT COUNT(*) AS n FROM users").get()!.n,5);
});
