import test from "node:test";
import assert from "node:assert/strict";
import {RawCommercialReference,sourceDecimal,verifyRawScenarios} from "../scripts/raw-commercial-reference";
import type {Report,Row} from "../shared/domain";
import {makeStore} from "./fixtures";
import {nativeFixture,nativeRows} from "./native-fixtures";

test("independent raw SQL reconciles known controls without normalized facts or compiler",()=>{
  const store=makeStore(),pkg=nativeFixture(),version=crypto.randomUUID();
  store.sql.prepare("INSERT INTO ci_imports(id,owner,actor,filename,bytes,sha256,object_key,status,base_generation,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(version,"test","test","synthetic.ci.ndjson",pkg.data.length,pkg.sha256,"local","published",0,1,1);
  for(const [id,rows]of Object.entries(nativeRows))for(const [index,values]of rows.entries())store.sql.prepare("INSERT INTO ci_raw_rows VALUES(?,?,?,?)").run(version,id,index+1,JSON.stringify(values));
  const reference=new RawCommercialReference(store.sql,pkg.manifest,version,{from:pkg.manifest.projection.from,to:pkg.manifest.projection.to});
  try{
    for(const control of pkg.manifest.controls){const result=reference.query(control.filters),actual=result[control.metric as keyof typeof result],expected=control.metric==="buyers"?Number(control.expected):sourceDecimal(control.expected,4);assert.equal(actual,expected,control.context+"/"+control.metric);}
    assert.equal(store.sql.prepare("SELECT COUNT(*) AS n FROM ci_native_sales").get()!.n,0);
    assert.equal(reference.counts.sales,4);
    assert.equal(sourceDecimal("-0.125000",4),-1250);
    assert.throws(()=>sourceDecimal("1.00001",4),/precision/);
    const total:Row={name:"Total",values:{gross:{current:350,previous:100},returns:{current:1034,previous:10},revenue:{current:-684,previous:90},buyers:{current:2,previous:1},margin:{current:null,previous:null}}};
    const report:Report={plan:{group:"month",metric:"revenue",order:"current",filters:{from:"2026-01",to:"2026-01",region:"",client:"",product:""}},source:"Arquivo manual (D1)",asOf:"2026-11-19T00:00:00Z",truncated:false,total,rows:[{...structuredClone(total),name:"2026-01"}]};
    const proof=verifyRawScenarios(reference,{national:report},{national:{}});
    assert.equal(proof.passed,true);assert.equal(proof.metricChecks,16);
    report.total.values.revenue.current=12345;
    assert.equal(verifyRawScenarios(reference,{national:report},{national:{}}).passed,false,"a changed application total fails the independent oracle");
  }finally{reference.close();store.sql.close();}
});

test("raw reference distinguishes explicit BLANK row keys from unrestricted filters",()=>{
  const store=makeStore(),rows=structuredClone(nativeRows);rows.s.push(["2026-01-02",null,null,"C","SP","São Paulo","25.0000"]);
  const pkg=nativeFixture(rows),version=crypto.randomUUID();
  store.sql.prepare("INSERT INTO ci_imports(id,owner,actor,filename,bytes,sha256,object_key,status,base_generation,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(version,"test","test","synthetic.ci.ndjson",pkg.data.length,pkg.sha256,"local","published",0,1,1);
  for(const [id,list]of Object.entries(rows))for(const [index,values]of list.entries())store.sql.prepare("INSERT INTO ci_raw_rows VALUES(?,?,?,?)").run(version,id,index+1,JSON.stringify(values));
  const reference=new RawCommercialReference(store.sql,pkg.manifest,version,{from:pkg.manifest.projection.from,to:pkg.manifest.projection.to});
  try{
    const filters={from:"2026-01-01",to:"2026-01-31"};
    assert.equal(reference.query(filters).gross,3750000);
    assert.deepEqual(reference.query({...filters,rowFilter:{dimension:"product",key:null}}),{gross:250000,returns:0,revenue:250000,buyers:1});
    assert.equal(reference.query({...filters,allowedRegions:["Rep A"],allowedClients:["0001"],rowFilter:{dimension:"product",key:"P"}}).revenue,850000);
    assert.deepEqual(reference.purchaseActivity({...filters,client:"0001",allowedRegions:["Rep A"]}),{lastPurchase:"2026-01-02",purchaseDays:2});
    assert.deepEqual(reference.purchaseActivity({...filters,client:"0001",product:"P",allowedRegions:["Rep A"]}),{lastPurchase:"2026-01-01",purchaseDays:1});
    assert.deepEqual(reference.purchaseActivity({...filters,client:"0001",allowedRegions:["Rep C"]}),{lastPurchase:null,purchaseDays:0});
    assert.throws(()=>reference.query({from:"2024-01-01",to:"2024-12-31"}),/coverage/);
  }finally{reference.close();store.sql.close();}
});
