import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

test("atualização do preparador preserva versão/mapeamento nas falhas e Unicode no Windows PowerShell", {
  skip: process.platform !== "win32",
}, () => {
  const output = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "tests/preparador-install.ps1"], {
    encoding: "utf8",
    timeout: 30000,
  });
  assert.match(output, /Installer tests passed: 11/);
});
