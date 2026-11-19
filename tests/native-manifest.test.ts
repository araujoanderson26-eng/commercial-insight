import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {resolve,join,dirname,basename} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {validateManualManifest} from "../worker/manual";
import {nativeFixture} from "./native-fixtures";
import {makeStore} from "./fixtures";

test("shared Worker preflight rejects shifted UTC metadata and future extraction",()=>{
  const s=makeStore();Object.assign(s.env,{MANUAL_ALLOW_SYNTHETIC:"true"});
  const valid=nativeFixture().manifest;assert.doesNotThrow(()=>validateManualManifest(valid,s.env));
  const shifted=structuredClone(valid);shifted.sourceUpdatedAt=new Date(new Date(shifted.extractedAt).valueOf()+3*3600000).toISOString();
  assert.throws(()=>validateManualManifest(shifted,s.env),/origem posterior à extração/);
  const future=structuredClone(valid);future.extractedAt=new Date(Date.now()+3600000).toISOString();future.sourceUpdatedAt=null;
  assert.throws(()=>validateManualManifest(future,s.env),/extração está no futuro/);
  const reference=structuredClone(valid);reference.referenceDate="2026-11-19";
  assert.throws(()=>validateManualManifest(reference,s.env),/referência posterior à extração/);
  s.sql.close();
});

test("CLI uses the Worker preflight and rejects a shifted source timestamp before loading any rows",()=>{
  const root=resolve(".wrangler");mkdirSync(root,{recursive:true});const directory=mkdtempSync(join(root,"native-manifest-parity-"));
  const input=join(directory,"invalid-time.ci.ndjson"),database=join(directory,"oracle.sqlite"),report=join(directory,"report.json");
  try{
    const pkg=nativeFixture(undefined,m=>{m.sourceUpdatedAt=new Date(new Date(m.extractedAt).valueOf()+3*3600000).toISOString();});writeFileSync(input,pkg.data);
    const result=spawnSync(process.execPath,["--import","tsx","scripts/validate-native-package.ts",input,database,report],{cwd:process.cwd(),encoding:"utf8"});
    assert.equal(result.status,1,result.stderr);const observed=JSON.parse(readFileSync(report,"utf8"));
    assert.equal(observed.ok,false);assert.equal(observed.error.stage,"manifest");assert.equal(observed.rows,0);assert.equal(observed.parts,0);assert.equal(observed.controls.length,0);
    const sql=new DatabaseSync(database,{readOnly:true});try{assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM ci_raw_rows").get()!.n,0);assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM ci_native_sales").get()!.n,0);}finally{sql.close();}
  }finally{
    // Remove only this newly generated directory of synthetic test artifacts.
    assert.equal(dirname(resolve(directory)),root);assert(basename(directory).startsWith("native-manifest-parity-"));rmSync(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  }
});
