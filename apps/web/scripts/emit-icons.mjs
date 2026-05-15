/**
 * Génère les icônes web + mipmaps Android à partir de :
 * - public/branding/icon-source.png (prioritaire, logo Budget Famille Ajoub)
 * - sinon public/branding/icon-source.svg
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const pngPath = path.join(root, "public", "branding", "icon-source.png");
const svgPath = path.join(root, "public", "branding", "icon-source.svg");
const mobileAssets = path.join(root, "..", "mobile", "assets");
const srcAssets = path.join(root, "src", "assets");
const webAssets = path.join(root, "assets");
const androidRes = path.join(root, "android", "app", "src", "main", "res");

/** Icônes lanceur classiques (dp → px par densité) */
const LEGACY_LAUNCHER = [
  ["mipmap-mdpi", 48],
  ["mipmap-hdpi", 72],
  ["mipmap-xhdpi", 96],
  ["mipmap-xxhdpi", 144],
  ["mipmap-xxxhdpi", 192]
];

/** Couche avant adaptive (zone 108dp, tailles px officielles) */
const ADAPTIVE_FG = [
  ["mipmap-mdpi", 108],
  ["mipmap-hdpi", 162],
  ["mipmap-xhdpi", 216],
  ["mipmap-xxhdpi", 324],
  ["mipmap-xxxhdpi", 432]
];

async function main() {
  let sharp;
  try {
    sharp = (await import("sharp")).default;
  } catch {
    console.warn("[emit-icons] sharp non installé : npm install -D sharp dans apps/web");
    process.exit(0);
  }

  const usePng = fs.existsSync(pngPath);
  const useSvg = !usePng && fs.existsSync(svgPath);
  if (!usePng && !useSvg) {
    console.error("[emit-icons] Missing source:", pngPath, "or", svgPath);
    process.exit(1);
  }

  const inputPath = usePng ? pngPath : svgPath;
  const buf = fs.readFileSync(inputPath);
  /** Icônes carrées : logo entier visible (évite le recadrage agressif des lanceurs adaptatifs). */
  const iconBg = { r: 255, g: 255, b: 255, alpha: 1 };
  const png = (outPath, size) =>
    sharp(buf).resize(size, size, { fit: "contain", background: iconBg }).png({ compressionLevel: 9 }).toFile(outPath);

  fs.mkdirSync(mobileAssets, { recursive: true });
  fs.mkdirSync(srcAssets, { recursive: true });
  fs.mkdirSync(webAssets, { recursive: true });

  await png(path.join(root, "public", "app-icon.png"), 1024);
  await png(path.join(root, "public", "adaptive-icon.png"), 1024);
  await png(path.join(root, "public", "favicon.png"), 64);
  await png(path.join(root, "public", "icon-192.png"), 192);
  await png(path.join(root, "public", "icon-512.png"), 512);

  await png(path.join(mobileAssets, "icon.png"), 1024);
  await png(path.join(mobileAssets, "adaptive-icon.png"), 1024);

  await png(path.join(srcAssets, "icon.png"), 1024);
  await png(path.join(webAssets, "icon.png"), 1024);
  await png(path.join(webAssets, "adaptive-icon.png"), 1024);

  const drawableDir = path.join(androidRes, "drawable");
  fs.mkdirSync(drawableDir, { recursive: true });
  await png(path.join(drawableDir, "splash_logo.png"), 512);

  for (const [folder, size] of LEGACY_LAUNCHER) {
    const dir = path.join(androidRes, folder);
    fs.mkdirSync(dir, { recursive: true });
    await png(path.join(dir, "ic_launcher.png"), size);
    await png(path.join(dir, "ic_launcher_round.png"), size);
  }

  for (const [folder, size] of ADAPTIVE_FG) {
    const dir = path.join(androidRes, folder);
    fs.mkdirSync(dir, { recursive: true });
    await png(path.join(dir, "ic_launcher_foreground.png"), size);
  }

  console.log(
    usePng
      ? "Wrote icons from PNG (Budget Famille Ajoub), Android mipmaps, splash_logo."
      : "Wrote icons from SVG, Android mipmaps, splash_logo."
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
