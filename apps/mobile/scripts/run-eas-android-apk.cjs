/**
 * Lance `eas build` avec EAS_NO_VCS et EAS_PROJECT_ROOT (apps/mobile) pour Windows / monorepo.
 */
const { spawnSync } = require("child_process");
const path = require("path");

const mobileRoot = path.resolve(__dirname, "..");
const env = {
  ...process.env,
  EAS_NO_VCS: "1",
  EAS_PROJECT_ROOT: mobileRoot
};

const r = spawnSync("npx", ["eas", "build", "--platform", "android", "--profile", "apk"], {
  cwd: mobileRoot,
  stdio: "inherit",
  env,
  shell: process.platform === "win32"
});

const code = r.status ?? 1;
if (code !== 0) {
  spawnSync(process.execPath, [path.join(__dirname, "eas-build-failed-hint.cjs")], { stdio: "inherit" });
}
process.exit(code);
