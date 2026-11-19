import test from "node:test";
import assert from "node:assert/strict";
import {validateManualManifest} from "../worker/manual";
import {fixturePackage} from "./manual-fixtures";
import {makeStore} from "./fixtures";

test("synthetic-only homologation rejects a real package before ingestion and keeps normal production validation",t=>{
  const {env,sql}=makeStore();t.after(()=>sql.close());
  env.MANUAL_ALLOW_SYNTHETIC="true";env.HML_SYNTHETIC_ONLY="true";
  const synthetic=fixturePackage().manifest;
  assert.doesNotThrow(()=>validateManualManifest(synthetic,env));
  const nonSynthetic={...synthetic,synthetic:false};
  assert.throws(()=>validateManualManifest(nonSynthetic,env),/exclusivamente pacotes sintéticos/);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM ci_imports").get()!.n,0);
  delete env.HML_SYNTHETIC_ONLY;
  assert.doesNotThrow(()=>validateManualManifest(nonSynthetic,env));
  delete env.MANUAL_ALLOW_SYNTHETIC;
  assert.throws(()=>validateManualManifest(synthetic,env),/apenas em ambiente de teste/);
});
