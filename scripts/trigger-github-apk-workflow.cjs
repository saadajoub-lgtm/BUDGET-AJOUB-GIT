/**
 * Déclenche le workflow GitHub "Capacitor Android APK (debug)" (workflow_dispatch).
 *
 * Prérequis : un Personal Access Token (classic) avec au moins la portée "workflow"
 * (ou "repo" si dépôt privé).
 *
 * Usage (PowerShell) :
 *   $env:GITHUB_TOKEN = "ghp_xxxxxxxx"
 *   node scripts/trigger-github-apk-workflow.cjs
 *
 * Optionnel :
 *   $env:GITHUB_REPOSITORY = "user/autre-repo"
 */
/* eslint-disable no-console */
const https = require("https");

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY || "saadajoub-lgtm/BUDGET-AJOUB-GIT";
const workflowFile = "capacitor-android-apk.yml";

if (!token) {
  console.error("Définissez GITHUB_TOKEN (PAT GitHub avec droit workflow).");
  process.exit(1);
}

const body = JSON.stringify({
  ref: "main",
  inputs: { publier_release_github: "true" }
});

const options = {
  hostname: "api.github.com",
  port: 443,
  path: `/repos/${repo}/actions/workflows/${workflowFile}/dispatches`,
  method: "POST",
  headers: {
    Accept: "application/vnd.github+json",
    "User-Agent": "budget-ajoub-trigger-apk",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body)
  }
};

const req = https.request(options, (res) => {
  let data = "";
  res.on("data", (c) => (data += c));
  res.on("end", () => {
    if (res.statusCode === 204) {
      console.log("OK : workflow déclenché (204).");
      console.log(`Ouvrez : https://github.com/${repo}/actions/workflows/${workflowFile}`);
      return;
    }
    console.error("HTTP", res.statusCode, data || res.statusMessage);
    process.exit(res.statusCode >= 400 ? 1 : 0);
  });
});

req.on("error", (e) => {
  console.error(e);
  process.exit(1);
});

req.write(body);
req.end();
