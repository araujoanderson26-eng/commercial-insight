import { Capacitor } from "@capacitor/core";
import { SplashScreen } from "@capacitor/splash-screen";
import { StatusBar, Style } from "@capacitor/status-bar";

const NATIVE_SESSION_KEY = "ci:native-session";

/** True only when running inside a compiled Capacitor Android/iOS container. */
export function isNativeApp(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

/** Optional remote API origin used by Capacitor builds (`VITE_API_BASE_URL`). */
export function apiBaseUrl(): string {
  try {
    const raw = (import.meta.env?.VITE_API_BASE_URL as string | undefined) ?? "";
    return raw.trim().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

export function apiUrl(path: string): string {
  const clean = path.replace(/^\/+/, "");
  const base = apiBaseUrl();
  return base ? `${base}/api/${clean}` : `/api/${clean}`;
}

export function getNativeToken(): string | null {
  if (!isNativeApp()) return null;
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage.getItem(NATIVE_SESSION_KEY) : null;
  } catch {
    return null;
  }
}

export function setNativeToken(token: string): void {
  if (!isNativeApp() || !token) return;
  try {
    if (typeof sessionStorage !== "undefined") sessionStorage.setItem(NATIVE_SESSION_KEY, token);
  } catch {
    // Ignore storage unavailability.
  }
}

export function clearNativeToken(): void {
  try {
    if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(NATIVE_SESSION_KEY);
  } catch {
    // Ignore storage unavailability.
  }
}

/** Configures native status bar and dismisses the Capacitor splash screen. */
export async function initMobileRuntime(): Promise<void> {
  if (!isNativeApp()) return;
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
    // SplashScreen plugin may already be dismissed.
  }
}
