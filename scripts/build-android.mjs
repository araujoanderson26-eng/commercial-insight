import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const rootDir = process.cwd();
const androidDir = join(rootDir, "android");
const localAppData = process.env.LOCALAPPDATA || "";

function firstExistingDir(candidates) {
  for (const dir of candidates) {
    if (dir && existsSync(dir)) return dir;
  }
  return "";
}

function findJdk21Home() {
  const explicit = process.env.JAVA_HOME;
  if (explicit && existsSync(join(explicit, "bin", process.platform === "win32" ? "java.exe" : "java"))) {
    return explicit;
  }
  const baseCandidates = [
    join(localAppData, "Android", "jdk-21"),
    "C:\\Program Files\\Eclipse Adoptium",
    "C:\\Program Files\\Java",
    "C:\\Program Files\\Android\\Android Studio\\jbr",
  ];
  for (const base of baseCandidates) {
    if (!existsSync(base)) continue;
    if (existsSync(join(base, "bin", "java.exe"))) return base;
    for (const child of readdirSync(base)) {
      const candidate = join(base, child);
      if (existsSync(join(candidate, "bin", "java.exe"))) return candidate;
    }
  }
  return "";
}

function findAndroidSdkHome() {
  return firstExistingDir([
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(localAppData, "Android", "Sdk"),
    "C:\\Android\\Sdk",
  ]);
}

const taskArg =
  process.argv.find((arg) => arg.startsWith("--task="))?.slice("--task=".length) ?? "assembleDebug";
const allowedTasks = new Set(["assembleDebug", "assembleRelease", "bundleRelease"]);
if (!allowedTasks.has(taskArg)) {
  throw Error(`Task Android inválida: ${taskArg}`);
}

const javaHome = findJdk21Home();
const androidSdk = findAndroidSdkHome();
if (!javaHome) {
  throw Error("JDK 21 não encontrado. Configure JAVA_HOME ou instale em %LOCALAPPDATA%\\Android\\jdk-21.");
}
if (!androidSdk) {
  throw Error("Android SDK não encontrado. Configure ANDROID_HOME ou instale em %LOCALAPPDATA%\\Android\\Sdk.");
}

const pathSep = process.platform === "win32" ? ";" : ":";
const env = {
  ...process.env,
  JAVA_HOME: javaHome,
  ANDROID_HOME: androidSdk,
  ANDROID_SDK_ROOT: androidSdk,
  PATH: `${join(javaHome, "bin")}${pathSep}${join(androidSdk, "platform-tools")}${pathSep}${process.env.PATH ?? ""}`,
};

const isWin = process.platform === "win32";
const gradlew = isWin ? resolve(androidDir, "gradlew.bat") : resolve(androidDir, "gradlew");
console.log(`Executando Gradle (${taskArg}) com JAVA_HOME=${javaHome} e ANDROID_HOME=${androidSdk}`);
const result = isWin
  ? spawnSync("cmd.exe", ["/d", "/c", "gradlew.bat", taskArg, "--no-daemon"], {
      cwd: androidDir,
      env,
      stdio: "inherit",
    })
  : spawnSync(gradlew, [taskArg, "--no-daemon"], {
      cwd: androidDir,
      env,
      stdio: "inherit",
    });
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const outputsDir = join(rootDir, "outputs", "mobile");
mkdirSync(outputsDir, { recursive: true });

const releaseSigned = Boolean(
  process.env.ANDROID_KEYSTORE_PATH &&
    process.env.ANDROID_KEYSTORE_PASSWORD &&
    process.env.ANDROID_KEY_ALIAS &&
    process.env.ANDROID_KEY_PASSWORD,
);

const artifactMap = {
  assembleDebug: {
    src: join(androidDir, "app", "build", "outputs", "apk", "debug", "app-debug.apk"),
    dest: join(outputsDir, "comercial-insight-2.0.0-debug.apk"),
  },
  assembleRelease: {
    src: join(androidDir, "app", "build", "outputs", "apk", "release", "app-release-unsigned.apk"),
    dest: join(outputsDir, "comercial-insight-2.0.0-release-unsigned.apk"),
  },
  bundleRelease: {
    src: join(androidDir, "app", "build", "outputs", "bundle", "release", "app-release.aab"),
    dest: join(
      outputsDir,
      releaseSigned
        ? "comercial-insight-2.0.0-release-signed.aab"
        : "comercial-insight-2.0.0-release-unsigned.aab",
    ),
  },
};

const target = artifactMap[taskArg];
if (target && existsSync(target.src)) {
  copyFileSync(target.src, target.dest);
  const sha256 = createHash("sha256").update(readFileSync(target.src)).digest("hex");
  const size = statSync(target.src).size;
  console.log(`Artefato gerado: ${target.dest} (${size} bytes, SHA-256: ${sha256})`);
}
