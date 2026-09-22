// Regenerate: npm i --no-save @resvg/resvg-js && node src-tauri/icons/source/make-icons.mjs src-tauri/icons/source
// then: npx tauri icon src-tauri/icons/source/forby.png (and delete the android/ios folders it creates)
// Builds the FORBY app icon and tray icons as SVG + PNG, mirroring Face.tsx (idle face, default colour)
import {Resvg} from "@resvg/resvg-js";
import fs from "node:fs";
import path from "node:path";

const OUT = process.argv[2];
fs.mkdirSync(OUT, {recursive: true});

// --- Face.tsx palette and projection ---
const COLOR = "#EDEBE4";
const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const mix = (hex, t) => "#" + hexToRgb(hex)
  .map((v) => (t > 0 ? v + (255 - v) * t : v * (1 + t)))
  .map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0"))
  .join("");
const top = mix(COLOR, 0.14);
const bottom = mix(COLOR, -0.2);
const FEATURE = "#1F1E1C";
const R = 90;
const DEG = Math.PI / 180;

const eye = (lonDeg, latDeg, h, w = 14) => {
  const lon = lonDeg * DEG;
  const lat = latDeg * DEG;
  const x = Math.sin(lon) * Math.cos(lat);
  const y = Math.sin(lat);
  const z = Math.cos(lon) * Math.cos(lat);
  const ang = Math.atan2(y, x) / DEG;
  const t = `translate(${(100 + R * x).toFixed(2)} ${(100 + R * y).toFixed(2)}) rotate(${ang.toFixed(1)}) scale(${z.toFixed(3)} 1) rotate(${(-ang).toFixed(1)})`;
  return `<g transform="${t}"><rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="${Math.min(w, h) / 2}" fill="${FEATURE}"/></g>`;
};

// idle: f(-13, -6, pill(34)), f(13, -6, pill(34))
const appSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="6 6 188 188" width="1024" height="1024">
  <defs>
    <radialGradient id="base" cx="40%" cy="35%" r="75%">
      <stop offset="0%" stop-color="${top}"/>
      <stop offset="100%" stop-color="${bottom}"/>
    </radialGradient>
    <radialGradient id="hl" cx="34%" cy="27%" r="38%">
      <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="rim" cx="50%" cy="50%" r="50%">
      <stop offset="62%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.3"/>
    </radialGradient>
  </defs>
  <circle cx="100" cy="100" r="90" fill="url(#base)"/>
  ${eye(-13, -6, 34)}
  ${eye(13, -6, 34)}
  <circle cx="100" cy="100" r="90" fill="url(#rim)"/>
  <circle cx="100" cy="100" r="90" fill="url(#hl)"/>
</svg>
`;

// Tray: flat light disc with a dark outline (readable on light and dark taskbars) and two bold pills.
// Drawn on a 32 grid with even coordinates, so the 16 px version stays on whole pixels.
const traySvg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}">
  <circle cx="16" cy="16" r="15" fill="${COLOR}" stroke="${FEATURE}" stroke-width="2"/>
  <rect x="10" y="8" width="4" height="12" rx="2" fill="${FEATURE}"/>
  <rect x="18" y="8" width="4" height="12" rx="2" fill="${FEATURE}"/>
</svg>
`;

const render = (svg, file) => {
  const png = new Resvg(svg, {background: "rgba(0,0,0,0)"}).render().asPng();
  fs.writeFileSync(path.join(OUT, file), png);
  console.log(file, png.length);
};

fs.writeFileSync(path.join(OUT, "forby.svg"), appSvg);
fs.writeFileSync(path.join(OUT, "tray.svg"), traySvg(32));
render(appSvg, "forby.png");
for (const s of [16, 20, 24, 32]) render(traySvg(s), `tray-${s}.png`);
