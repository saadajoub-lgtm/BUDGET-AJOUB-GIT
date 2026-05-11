import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Charger l’app depuis l’hébergement Firebase : même comportement que le navigateur
 * (Firebase Auth, Axios / intercepteurs, pas de « localhost » dans le WebView).
 * L’APK est une coque légère ; un rebuild natif n’est pas nécessaire à chaque changement du site.
 */
const config: CapacitorConfig = {
  appId: "com.ajoub.budget",
  appName: "Budget Ajoub",
  webDir: "dist",
  server: {
    url: "https://budget-famille-ajoub.web.app",
    cleartext: false,
    androidScheme: "https",
    allowNavigation: [
      "https://budget-famille-ajoub.web.app",
      "https://budget-famille-ajoub.web.app/*",
      // Connexion Google / Firebase Auth dans le WebView
      "https://accounts.google.com/*",
      "https://*.google.com/*",
      "https://www.googleapis.com/*",
      "https://securetoken.googleapis.com/*"
    ]
  }
};

export default config;

