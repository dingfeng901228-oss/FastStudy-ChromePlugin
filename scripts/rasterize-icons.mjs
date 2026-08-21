#!/usr/bin/env node
// rasterize-icons.mjs
//
// Rasterize public/icons/icon.svg → public/icons/icon-{16,32,48,128}.png
// for Chrome extension manifest `icons` field.
//
// Why a script (not a Vite plugin):
//   - Vite has no built-in SVG→PNG rasterizer
//   - sharp is the canonical choice (libvips, prebuilt binaries)
//   - Idempotent: safe to re-run; overwrites output PNGs
//   - One-off dev tool; not part of `vite build` (output checked in to git
//     so the build stays reproducible without sharp at build time)
//
// Usage:
//   node scripts/rasterize-icons.mjs
//
// Output:
//   public/icons/icon-16.png   (Chrome favicon)
//   public/icons/icon-32.png   (Windows taskbar)
//   public/icons/icon-48.png   (Linux app launcher / extensions page)
//   public/icons/icon-128.png  (Chrome Web Store listing + install dialog)

import sharp from 'sharp';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = resolve(__dirname, '..', 'public', 'icons');
const SVG_PATH = resolve(ICONS_DIR, 'icon.svg');
const SIZES = [16, 32, 48, 128];

const svg = readFileSync(SVG_PATH);
mkdirSync(ICONS_DIR, { recursive: true });

for (const size of SIZES) {
  const out = resolve(ICONS_DIR, `icon-${size}.png`);
  await sharp(svg)
    .resize(size, size, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toFile(out);
  console.log(`[OK] icon-${size}.png  (${size}x${size})`);
}

console.log(`\n[DONE] Rasterized ${SIZES.length} icon sizes to public/icons/`);
