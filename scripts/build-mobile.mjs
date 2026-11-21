import { spawnSync } from "node:child_process";

const ENV_URLS = {
  production: "https://commercial-insight.araujoempresarial.com.br",
  hml: "https://commercial-insight-hml.araujo-anderson26.workers.dev",
};

const envArg = process.argv.find((arg) => arg.startsWith("--env="))?.slice("--env=".length) ?? "production";
if (envArg !== "production" && envArg !== "hml") {
  throw Error(`Ambiente inválido "${envArg}". Use --env=production ou --env=hml.`);
}

const rawUrl = (process.env.VITE_API_BASE_URL || ENV_URLS[envArg]).trim().replace(/\/+$/, "");
const parsed = new URL(rawUrl);
if (parsed.protocol !== "https:" || parsed.origin !== rawUrl) {
  throw Error(`VITE_API_BASE_URL precisa ser uma origem HTTPS exata sem barra final: ${rawUrl}`);
}
if (envArg === "hml" && rawUrl === ENV_URLS.production) {
  throw Error("Build mobile HML não pode apontar para a origem de produção.");
}

const env = {
  ...process.env,
  VITE_API_BASE_URL: rawUrl,
  VITE_APP_ENV: process.env.VITE_APP_ENV || envArg,
};

function runNodeScript(args) {
  const res = spawnSync(process.execPath, args, { stdio: "inherit", env });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

console.log(`Compilando bundle mobile (${env.VITE_APP_ENV}) -> ${rawUrl}`);
runNodeScript(["./node_modules/vite/bin/vite.js", "build", "--mode", "mobile"]);
runNodeScript(["scripts/sw.mjs"]);
