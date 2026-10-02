// Renders the product video frames. From the repository root:
//   mkdir -p /tmp/frames && node docs/video/source/render.mjs full /tmp/frames
//   ffmpeg -framerate 30 -i /tmp/frames/f%04d.png -c:v libx264 -crf 20 -pix_fmt yuv420p -movflags +faststart docs/video/quickscan-product-video.mp4
// Set PW_CHROMIUM_PATH to use a specific Chromium build.
import { chromium } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const [mode, out] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: process.env.PW_CHROMIUM_PATH || undefined });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
await p.goto('file://' + join(dirname(fileURLToPath(import.meta.url)), 'index.html'));
await p.evaluate(() => document.fonts.ready);
await p.waitForTimeout(300);
const times = mode === 'preview' ? [0.5, 1.6, 3.6, 6.0, 8.6, 11.2, 14.5] : Array.from({ length: 450 }, (_, i) => i / 30);
let i = 0;
for (const t of times) {
  await p.evaluate((t) => window.render(t), t);
  await p.screenshot({ path: `${out}/f${String(i++).padStart(4, '0')}.png` });
}
await b.close();
