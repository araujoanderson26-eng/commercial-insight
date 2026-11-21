import { App } from "@capacitor/app";
import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { Keyboard } from "@capacitor/keyboard";
import { Network } from "@capacitor/network";
import { SplashScreen } from "@capacitor/splash-screen";
import { StatusBar, Style } from "@capacitor/status-bar";

const LEGACY_NATIVE_SESSION_KEY = "ci:native-session";

type SecureSessionPlugin = {
  get(): Promise<{ value: string | null }>;
  set(options: { value: string }): Promise<void>;
  clear(): Promise<void>;
};

type NativePrintPlugin = {
  printHtml(options: { html: string; jobName: string }): Promise<{ printed: boolean }>;
};

export const SecureSession = registerPlugin<SecureSessionPlugin>("SecureSession");
export const NativePrint = registerPlugin<NativePrintPlugin>("NativePrint");

let nativeTokenMemory: string | null = null;
const cleanups: (() => Promise<void>)[] = [];

/** True only when running inside a compiled Capacitor Android/iOS container. */
export function isNativeApp(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

export function registerNativeCleanup(fn: () => Promise<void>): void {
  cleanups.push(fn);
}

/** Resolves and validates API URLs cleanly; enforces HTTPS for native mobile requests. */
export function resolveApiUrl(
  path: string,
  opts: { native: boolean; baseUrl?: string },
): string {
  const clean = path.replace(/^\/+/, "");
  const rawBase = (opts.baseUrl ?? "").trim().replace(/\/+$/, "");
  if (rawBase) {
    let parsed: URL;
    try {
      parsed = new URL(rawBase);
    } catch {
      throw Error("Endereço do servidor inválido para o aplicativo mobile.");
    }
    if (parsed.protocol !== "https:") {
      throw Error("O aplicativo mobile exige conexão HTTPS com o servidor.");
    }
    return `${parsed.origin}/api/${clean}`;
  }
  if (opts.native) {
    throw Error("Configure VITE_API_BASE_URL em HTTPS para compilar o aplicativo mobile.");
  }
  return `/api/${clean}`;
}

/** Optional remote API origin used by Capacitor builds (`VITE_API_BASE_URL`). */
export function apiBaseUrl(): string {
  try {
    const raw = (import.meta.env?.VITE_API_BASE_URL as string | undefined) ?? "";
    const trimmed = raw.trim().replace(/\/+$/, "");
    if (!trimmed) return "";
    const parsed = new URL(trimmed);
    return parsed.protocol === "https:" ? parsed.origin : "";
  } catch {
    return "";
  }
}

export function apiUrl(path: string): string {
  let raw = "";
  try {
    raw = ((import.meta.env?.VITE_API_BASE_URL as string | undefined) ?? "").trim();
  } catch {
    raw = "";
  }
  return resolveApiUrl(path, { native: isNativeApp(), baseUrl: raw });
}

export function appEnvironmentLabel(): "Homologação" | "Produção" | "Web" {
  const base = apiBaseUrl();
  if (!base) return isNativeApp() ? "Produção" : "Web";
  return base.includes("-hml.") ? "Homologação" : "Produção";
}

function wipeLegacyWebSessionStorage(): void {
  try {
    if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(LEGACY_NATIVE_SESSION_KEY);
  } catch {
    // Ignore storage unavailability.
  }
}

/** Hydrates encrypted OS Keystore/Keychain token into RAM once before first API call. */
export async function hydrateNativeSession(
  plugin: SecureSessionPlugin = SecureSession,
  nativeOverride?: boolean,
): Promise<string | null> {
  const native = nativeOverride ?? isNativeApp();
  if (!native) return null;
  wipeLegacyWebSessionStorage();
  try {
    const res = await plugin.get();
    nativeTokenMemory = res?.value && /^[a-f0-9]{64}$/.test(res.value) ? res.value : null;
  } catch {
    nativeTokenMemory = null;
  }
  return nativeTokenMemory;
}

export function getNativeToken(): string | null {
  return isNativeApp() ? nativeTokenMemory : null;
}

export async function setNativeToken(
  token: string,
  plugin: SecureSessionPlugin = SecureSession,
  nativeOverride?: boolean,
): Promise<void> {
  const native = nativeOverride ?? isNativeApp();
  if (!native || !/^[a-f0-9]{64}$/.test(token)) return;
  nativeTokenMemory = token;
  wipeLegacyWebSessionStorage();
  try {
    await plugin.set({ value: token });
  } catch {
    // Keep RAM session active if keystore plugin is unavailable in browser previews.
  }
}

export async function clearNativeToken(
  plugin: SecureSessionPlugin = SecureSession,
): Promise<void> {
  nativeTokenMemory = null;
  wipeLegacyWebSessionStorage();
  try {
    await plugin.clear();
  } catch {
    // Ignore plugin unavailability on non-native platforms.
  }
  for (const fn of cleanups) {
    try {
      await fn();
    } catch {
      // Ignore cleanup errors on shutdown.
    }
  }
}

export type MobileRuntimeHandlers = {
  onNetworkChange?: (connected: boolean) => void;
  onAppResume?: () => void;
  onBackButton?: () => boolean;
};

/** Configures native chrome, keyboard behavior, network observer and Android back navigation. */
export async function initMobileRuntime(
  handlers: MobileRuntimeHandlers = {},
): Promise<() => void> {
  if (!isNativeApp()) return () => {};
  let disposed = false;
  const handles: Promise<PluginListenerHandle>[] = [];

  if (typeof document !== "undefined") {
    document.documentElement.classList.add("native-app");
  }

  try {
    await StatusBar.setOverlaysWebView({ overlay: false });
    await StatusBar.setStyle({ style: Style.Dark });
    await StatusBar.setBackgroundColor({ color: "#091c36" });
  } catch {
    // StatusBar plugin may not be active on all platforms.
  }

  try {
    await SplashScreen.hide();
  } catch {
    // SplashScreen may already be dismissed.
  }

  const setKeyboardOpen = (open: boolean) => {
    if (typeof document !== "undefined") {
      document.body.classList.toggle("keyboard-open", open);
    }
  };

  try {
    handles.push(Keyboard.addListener("keyboardWillShow", () => setKeyboardOpen(true)));
    handles.push(Keyboard.addListener("keyboardDidShow", () => setKeyboardOpen(true)));
    handles.push(Keyboard.addListener("keyboardWillHide", () => setKeyboardOpen(false)));
    handles.push(Keyboard.addListener("keyboardDidHide", () => setKeyboardOpen(false)));
  } catch {
    // Keyboard listeners unavailable on platform.
  }

  try {
    void Network.getStatus()
      .then((status) => {
        if (!disposed) handlers.onNetworkChange?.(status.connected);
      })
      .catch(() => {});
    handles.push(
      Network.addListener("networkStatusChange", (status) => {
        if (!disposed) handlers.onNetworkChange?.(status.connected);
      }),
    );
  } catch {
    // Network plugin unavailable on platform.
  }

  try {
    handles.push(
      App.addListener("appStateChange", (state) => {
        if (!disposed && state.isActive) handlers.onAppResume?.();
      }),
    );
    handles.push(
      App.addListener("backButton", () => {
        if (disposed) return;
        const handled = handlers.onBackButton?.() ?? false;
        if (!handled) {
          void App.minimizeApp().catch(() => {});
        }
      }),
    );
  } catch {
    // App listeners unavailable on platform.
  }

  return () => {
    disposed = true;
    setKeyboardOpen(false);
    for (const promise of handles) {
      void promise.then((h) => h.remove()).catch(() => {});
    }
  };
}
