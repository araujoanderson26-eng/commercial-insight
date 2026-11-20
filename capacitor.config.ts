import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "br.com.araujoempresarial.commercialinsight",
  appName: "Comercial Insight",
  webDir: "dist",
  server: {
    androidScheme: "https",
    ...(process.env.CAPACITOR_SERVER_URL
      ? { url: process.env.CAPACITOR_SERVER_URL, cleartext: false }
      : {}),
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
      resize: "body",
    },
  },
};

export default config;
