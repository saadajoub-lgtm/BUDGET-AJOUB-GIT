/**
 * Build web dist, sync into Android project, then assemble a debug APK (no Expo / no EAS).
 * Prérequis : JDK 17+ et Android SDK (ANDROID_HOME), ou Android Studio avec SDK installé.
 * Sortie : android/app/build/outputs/apk/debug/app-debug.apk
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const webRoot = path.join(__dirname, "..");
const androidRoot = path.join(webRoot, "android");
const gradle = process.platform === "win32" ? "gradlew.bat" : "./gradlew";

function run(cmd, cwd) {
  execSync(cmd, { cwd, stdio: "inherit", shell: true });
}

function findAndroidSdkDir() {
  const env = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT].filter(Boolean);
  for (const p of env) {
    if (fs.existsSync(p) && fs.existsSync(path.join(p, "platform-tools"))) return p;
  }
  const localAppData = process.env.LOCALAPPDATA || "";
  const userProfile = process.env.USERPROFILE || "";
  const candidates = [
    path.join(localAppData, "Android", "Sdk"),
    path.join(userProfile, "AppData", "Local", "Android", "Sdk"),
    path.join(userProfile, "Library", "Android", "sdk"),
    "/Users/Shared/Android/sdk",
    "C:\\Android\\Sdk"
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c) && fs.existsSync(path.join(c, "platform-tools"))) return c;
  }
  return null;
}

function ensureAndroidLocalProperties() {
  const propsPath = path.join(androidRoot, "local.properties");
  let sdkDir = null;
  if (fs.existsSync(propsPath)) {
    const raw = fs.readFileSync(propsPath, "utf8");
    const m = /sdk\.dir\s*=\s*(.+)/.exec(raw);
    if (m) {
      const val = m[1].trim().replace(/\\\\/g, "\\");
      if (fs.existsSync(val) && fs.existsSync(path.join(val, "platform-tools"))) sdkDir = val;
    }
  }
  if (!sdkDir) sdkDir = findAndroidSdkDir();
  if (!sdkDir) {
    const envHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || "";
    const defaultWin = path.join(process.env.LOCALAPPDATA || "", "Android", "Sdk");
    console.error("\nSDK Android introuvable (dossier platform-tools requis).\n");
    if (envHome) {
      const pt = path.join(envHome, "platform-tools");
      console.error("ANDROID_HOME / ANDROID_SDK_ROOT =", envHome);
      console.error("  existe ?", fs.existsSync(envHome), "| platform-tools ?", fs.existsSync(pt));
    } else {
      console.error("Aucune variable ANDROID_HOME / ANDROID_SDK_ROOT definie dans cette session.");
    }
    console.error("Emplacement attendu par defaut (Windows) :", defaultWin);
    console.error("  existe ?", fs.existsSync(defaultWin));
    console.error(
      "\nCorrections possibles :\n" +
        "  1) Installez Android Studio et le SDK : https://developer.android.com/studio\n" +
        "  2) Android Studio : Settings > Languages & Frameworks > Android SDK > copiez Android SDK Location\n" +
        "  3) Dans cmd : set ANDROID_HOME=C:\\chemin\\vers\\Sdk\n" +
        "  4) Fichier apps/web/android/local.properties (contenu texte, pas une commande cmd) :\n" +
        "       sdk.dir=C:/Users/VOTRE_USER/AppData/Local/Android/Sdk\n" +
        "  5) Double-clic sur build-apk.cmd a la racine du depot\n"
    );
    process.exit(1);
  }
  const sdkDirForFile = sdkDir.replace(/\\/g, "/");
  fs.writeFileSync(
    propsPath,
    `## Genere par scripts/build-android-debug.cjs (ne pas committer si vous preferez)\nsdk.dir=${sdkDirForFile}\n`,
    "utf8"
  );
  console.log("SDK Android :", sdkDir);
}

ensureAndroidLocalProperties();

run("npm run build", webRoot);
run("npx cap sync android", webRoot);
run(`${gradle} assembleDebug`, androidRoot);

console.log("\nAPK debug :");
console.log(path.join(androidRoot, "app", "build", "outputs", "apk", "debug", "app-debug.apk"));
