// DEV-ONLY: generate on-brand "lookbook" PNG tiles for the seeded storefront fixture products and
// upload them to a public local Supabase storage bucket. Pure-Node PNG encoder (no deps, no network).
// Not part of the product; a convenience for local visual testing of the storefront.
import { deflateSync } from "node:zlib";

const STORAGE = "http://127.0.0.1:54321/storage/v1";
const BUCKET = "product-media";
const SERVICE_ROLE =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const W = 720;
const H = 900;

// ---- clay palette ----------------------------------------------------------
const C = {
  forest: [38, 65, 58],
  deep: [23, 42, 36],
  clay: [162, 63, 45],
  clayDeep: [132, 48, 31],
  cream: [245, 241, 234],
  sand: [230, 221, 205],
  olive: [108, 120, 92],
};

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

// Deterministic value noise for a subtle fabric grain.
function noise(x, y, seed) {
  const n = Math.sin(x * 12.9898 + y * 78.233 + seed * 37.719) * 43758.5453;
  return n - Math.floor(n);
}

// Each composition paints a 4:5 editorial tile in the clay palette.
function paint(kind, seed) {
  const buf = Buffer.alloc(H * (W * 4 + 1));
  for (let y = 0; y < H; y++) {
    const rowStart = y * (W * 4 + 1);
    buf[rowStart] = 0; // PNG filter: none
    const fy = y / H;
    for (let x = 0; x < W; x++) {
      const fx = x / W;
      let col;
      if (kind === "linen") {
        // soft vertical gradient cream->sand with fine vertical "weave" lines
        const base = mix(C.cream, C.sand, fy * 0.9 + 0.05);
        const weave = Math.sin(x * 0.55) * 0.5 + Math.sin(y * 0.5) * 0.5;
        col = mix(base, C.forest, 0.04 + weave * 0.02);
      } else if (kind === "fold") {
        // diagonal fabric fold: forest -> deep with a bright clay seam
        const d = fx * 0.6 + fy * 0.4;
        col = mix(C.forest, C.deep, d);
        const seam = Math.abs(fx - fy - 0.08);
        if (seam < 0.04) col = mix(col, C.clay, (0.04 - seam) / 0.04);
      } else if (kind === "drape") {
        // vertical clay drape with soft shadow bands
        const band = Math.sin(fx * Math.PI * 3.2 + 0.3) * 0.5 + 0.5;
        col = mix(C.clay, C.clayDeep, band * 0.7 + fy * 0.2);
      } else if (kind === "arc") {
        // concentric arcs (tote): cream field with forest rings + clay core
        const cx = 0.5;
        const cy = 0.62;
        const r = Math.hypot(fx - cx, (fy - cy) * 1.05);
        const ring = (Math.sin(r * 34) * 0.5 + 0.5) ** 2;
        col = mix(C.cream, C.forest, 0.1 + ring * 0.16);
        if (r < 0.14) col = mix(col, C.clay, (0.14 - r) / 0.14);
      } else {
        // "stack": horizontal sand/olive strata
        const t = (Math.sin(fy * Math.PI * 4) * 0.5 + 0.5) * 0.5 + fy * 0.3;
        col = mix(C.sand, C.olive, t);
      }
      // vignette + grain
      const vig = 1 - (Math.hypot(fx - 0.5, fy - 0.5) - 0.2) * 0.22;
      const g = (noise(x, y, seed) - 0.5) * 10;
      const o = rowStart + 1 + x * 4;
      buf[o] = clamp(col[0] * vig + g);
      buf[o + 1] = clamp(col[1] * vig + g);
      buf[o + 2] = clamp(col[2] * vig + g);
      buf[o + 3] = 255;
    }
  }
  return buf;
}

// ---- minimal PNG container -------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(rawFilteredRgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const idat = deflateSync(rawFilteredRgba, { level: 6 });
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function ensureBucket() {
  const res = await fetch(`${STORAGE}/bucket`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SERVICE_ROLE}`,
      apikey: SERVICE_ROLE,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: BUCKET, id: BUCKET, public: true }),
  });
  if (res.ok) {
    console.log(`bucket "${BUCKET}" created`);
    return;
  }
  const text = await res.text();
  if (res.status === 409 || /already exists/i.test(text)) {
    console.log(`bucket "${BUCKET}" already exists`);
    return;
  }
  throw new Error(`bucket create failed ${res.status}: ${text}`);
}

async function upload(path, png) {
  const res = await fetch(`${STORAGE}/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SERVICE_ROLE}`,
      apikey: SERVICE_ROLE,
      "Content-Type": "image/png",
      "x-upsert": "true",
    },
    body: png,
  });
  if (!res.ok) throw new Error(`upload ${path} failed ${res.status}: ${await res.text()}`);
  console.log(`uploaded ${path} (${(png.length / 1024).toFixed(0)} KB)`);
}

const PLAN = [
  { path: "dev-linen-shirt/01.png", kind: "linen", seed: 1 },
  { path: "dev-linen-shirt/02.png", kind: "fold", seed: 2 },
  { path: "dev-linen-shirt/03.png", kind: "drape", seed: 3 },
  { path: "dev-canvas-tote/01.png", kind: "arc", seed: 4 },
  { path: "dev-canvas-tote/02.png", kind: "stack", seed: 5 },
];

await ensureBucket();
for (const item of PLAN) {
  await upload(item.path, encodePng(paint(item.kind, item.seed)));
}
console.log("done");
