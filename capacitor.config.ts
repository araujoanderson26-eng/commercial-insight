import type { CapacitorConfig } from "@capacitor/cli";
import { KeyboardResize } from "@capacitor/keyboard";

const config: CapacitorConfig = {
  appId: "br.com.araujoempresarial.commercialinsight",
  appName: "Comercial Insight",
  webDir: "dist",
  backgroundColor: "#091c36",
  server: {
    androidScheme: "https",
    iosScheme: "capacitor",
    ...(process.env.CAPACITOR_SERVER_URL
      ? { url: process.env.CAPACITOR_SERVER_URL, cleartext: false }
      : {}),
  },
  android: {
    allowMixedContent: false,
    webContentsDebuggingEnabled: process.env.CAPACITOR_DEBUG === "true",
    backgroundColor: "#091c36",
  },
  ios: {
    contentInset: "automatic",
    scrollEnabled: true,
    backgroundColor: "#091c36",
  },
  plugins: {
    StatusBar: {
      backgroundColor: "#091c36",
      style: "DARK",
      overlaysWebView: false,
    },
    SplashScreen: {
      backgroundColor: "#091c36",
      launchShowDuration: 900,
      launchAutoHide: true,
      showSpinner: false,
    },
    Keyboard: {
      resize: KeyboardResize.Body,
      resizeOnFullScreen: true,
    },
  },
};

export default config;
