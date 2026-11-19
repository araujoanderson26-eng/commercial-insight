import test from "node:test";
import assert from "node:assert/strict";
import { syntheticHmlPackage } from "../scripts/hml-fixture";
import { makeStore } from "./fixtures";
import { fakeR2 } from "./manual-fixtures";
import { dataStatus, processManualJobs, queryManual } from "../worker/manual";
import type { DbUser } from "../worker/core";

const admin:DbUser={id:"hml-fixture-admin",name:"SINTÉTICO HML",email:"synthetic-hml@example.test",role:"admin",password:"unused",regions:"[]",clients:"[]",national:1,active:1,entra_oid:null,scope_version:1,version:1};
test("homologation fixture reconciles names and metrics, while its divergent KPI cannot replace the active snapshot",async t=>{
  const store=makeStore(),r2=fakeR2();t.after(()=>store.sql.close());
  Object.assign(store.env,{BUCKET:r2.bucket,MANUAL_ALLOW_SYNTHETIC:"true"});
  const publish=async(invalid=false)=>{
    const pkg=syntheticHmlPackage(invalid),id=crypto.randomUUID(),key="synthetic-hml/"+id;
    assert.equal(pkg.manifest.synthetic,true);assert.match(pkg.manifest.model.name,/SINTÉTICO/);
    r2.objects.set(key,pkg.data);
    const generation=Number(store.sql.prepare("SELECT generation FROM ci_sources").get()!.generation);
    store.sql.prepare("INSERT INTO ci_imports(id,owner,actor,filename,bytes,sha256,object_key,status,base_generation,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(id,admin.id,admin.name,"SINTETICO-HML.ci.ndjson",pkg.data.length,pkg.sha256,key,"queued",generation,1,1);
    store.sql.prepare("UPDATE ci_sources SET source='manual',latest_import_id=?").run(id);
    for(let i=0;i<35;i++)await processManualJobs(store.env);
    return{id,pkg,row:store.sql.prepare("SELECT status,report FROM ci_imports WHERE id=?").get(id)!};
  };
  const first=await publish();assert.equal(first.row.status,"published");
  const controls=JSON.parse(String(first.row.report)).controls as{passed:boolean}[];assert.equal(controls.length,36);assert.ok(controls.every(c=>c.passed));
  assert.equal(first.pkg.manifest.inventory.tables.length,10);assert.equal(first.pkg.manifest.inventory.tables.reduce((n,table)=>n+table.rowCount,0),32);
  const filters={from:"2026-01",to:"2026-01",client:"",product:"",region:""};
  const plan={filters,metric:"revenue" as const,group:"client" as const,order:"current" as const};
  const national=await queryManual(store.env,admin,plan);
  assert.equal(national.total.values.revenue.current,-684);assert.equal(national.total.values.revenue.previous,90);
  assert.equal(national.rows.find(row=>row.key==="0001")?.name,"0001 — Cliente SINTÉTICO 0001");
  const products=await queryManual(store.env,admin,{...plan,group:"product",filters:{...filters,client:"0001"}});
  assert.ok(products.rows.some(row=>row.name==="P — Produto SINTÉTICO P"));
  const second=await publish(true);assert.equal(second.row.status,"failed");assert.equal((await dataStatus(store.env)).active?.id,first.id);
  assert.equal((await queryManual(store.env,admin,plan)).total.values.revenue.current,-684);
});
