import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { NativePrint, registerNativeCleanup } from "./runtime";

const EXPORT_DIR = "exports";

export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function sanitizeFilename(name: string): string {
  const withoutControls = Array.from(name.normalize("NFC"), (ch) =>
    ch.charCodeAt(0) < 32 ? "-" : ch,
  ).join("");
  const cleaned = withoutControls
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  return cleaned || "relatorio-comercial";
}

export function isUserShareCancel(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /share\s+canceled|canceled|cancelled|aborted/i.test(msg);
}

export async function purgeNativeExportCache(): Promise<void> {
  try {
    await Filesystem.rmdir({
      path: EXPORT_DIR,
      directory: Directory.Cache,
      recursive: true,
    });
  } catch {
    // Ignore when cache directory does not exist.
  }
}

registerNativeCleanup(purgeNativeExportCache);

export async function shareNativeFile(opts: {
  filename: string;
  bytes: Uint8Array;
  title: string;
}): Promise<void> {
  const safeName = sanitizeFilename(opts.filename);
  const path = `${EXPORT_DIR}/${safeName}`;
  await Filesystem.writeFile({
    path,
    data: uint8ToBase64(opts.bytes),
    directory: Directory.Cache,
    recursive: true,
  });
  const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
  await Share.share({
    title: opts.title,
    text: opts.title,
    files: [uri],
    dialogTitle: opts.title,
  });
}

export async function printOrShareNativeHtml(opts: {
  html: string;
  filename: string;
  jobName: string;
}): Promise<void> {
  try {
    const res = await NativePrint.printHtml({
      html: opts.html,
      jobName: opts.jobName,
    });
    if (res?.printed) return;
  } catch {
    // Fall back to sharing printable HTML via OS Share Sheet if native print dialog fails.
  }
  const safeName = sanitizeFilename(opts.filename).replace(/\.html?$/i, "") + ".html";
  const path = `${EXPORT_DIR}/${safeName}`;
  await Filesystem.writeFile({
    path,
    data: opts.html,
    directory: Directory.Cache,
    encoding: Encoding.UTF8,
    recursive: true,
  });
  const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
  await Share.share({
    title: opts.jobName,
    text: opts.jobName,
    files: [uri],
    dialogTitle: opts.jobName,
  });
}
