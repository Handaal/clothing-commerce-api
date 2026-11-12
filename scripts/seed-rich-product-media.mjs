// DEV-ONLY: generate on-brand "lookbook" PNG tiles for the rich catalog fixture and upload them to the
// local public Supabase storage bucket. Pure-Node PNG encoder (no deps). Mirrors seed-dev-product-media.mjs
// but covers the full rich catalog (two tiles per product). Not part of the product.
import { deflateSync } from "node:zlib";

const STORAGE = "http://127.0.0.1:54321/storage/v1";
const BUCKET = "product-media";
const SERVICE_ROLE =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const W = 720;
const H = 900;
const C = {
  forest: [38, 65, 58],
  deep: [23, 42, 36],
  clay: [162, 63, 45],
  clayDeep: [132, 48, 31],
  cream: [245, 241, 234],
  sand: [230, 221, 205],
  olive: [108, 120, 92],
  indigo: [46, 58, 92],
  indigoDeep: [28, 36, 60],
  slate: [96, 108, 120],
};
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
function noise(x, y, seed) {
  const n = Math.sin(x * 12.9898 + y * 78.233 + seed * 37.719) * 43758.5453;
  return n - Math.floor(n);
}
function paint(kind, seed) {
  const buf = Buffer.alloc(H * (W * 4 + 1));
  for (let y = 0; y < H; y++) {
    const rowStart = y * (W * 4 + 1);
    buf[rowStart] = 0;
    const fy = y / H;
    for (let x = 0; x < W; x++) {
      const fx = x / W;
      let col;
      if (kind === "linen") {
        const base = mix(C.cream, C.sand, fy * 0.9 + 0.05);
        const weave = Math.sin(x * 0.55) * 0.5 + Math.sin(y * 0.5) * 0.5;
        col = mix(base, C.forest, 0.04 + weave * 0.02);
      } else if (kind === "fold") {
        const d = fx * 0.6 + fy * 0.4;
        col = mix(C.forest, C.deep, d);
        const seam = Math.abs(fx - fy - 0.08);
        if (seam < 0.04) col = mix(col, C.clay, (0.04 - seam) / 0.04);
      } else if (kind === "drape") {
        const band = Math.sin(fx * Math.PI * 3.2 + 0.3) * 0.5 + 0.5;
        col = mix(C.clay, C.clayDeep, band * 0.7 + fy * 0.2);
      } else if (kind === "arc") {
        const cx = 0.5,
          cy = 0.62;
        const r = Math.hypot(fx - cx, (fy - cy) * 1.05);
        const ring = (Math.sin(r * 34) * 0.5 + 0.5) ** 2;
        col = mix(C.cream, C.forest, 0.1 + ring * 0.16);
        if (r < 0.14) col = mix(col, C.clay, (0.14 - r) / 0.14);
      } else if (kind === "denim") {
        const twill = Math.sin((x + y) * 0.9) * 0.5 + 0.5;
        col = mix(C.indigo, C.indigoDeep, fy * 0.5 + twill * 0.18);
        if (fy > 0.9) col = mix(col, C.sand, (fy - 0.9) * 2.2); // hem fade
      } else if (kind === "knit") {
        const rib = Math.sin(fx * Math.PI * 22) * 0.5 + 0.5;
        col = mix(C.olive, C.sand, 0.3 + rib * 0.2 - fy * 0.1);
      } else if (kind === "mono") {
        col = mix(C.slate, C.deep, fy * 0.7 + Math.sin(fx * 6) * 0.04);
      } else {
        const t = (Math.sin(fy * Math.PI * 4) * 0.5 + 0.5) * 0.5 + fy * 0.3;
        col = mix(C.sand, C.olive, t);
      }
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
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(raw) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = deflateSync(raw, { level: 6 });
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
  if (res.ok) return console.log(`bucket "${BUCKET}" created`);
  const text = await res.text();
  if (res.status === 409 || /already exists/i.test(text))
    return console.log(`bucket "${BUCKET}" exists`);
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
}

// slug -> [primaryKind, secondaryKind]; chosen to suit each category.
const CATALOG = {
  "everyday-crew-tee": ["linen", "stack"],
  "heavyweight-boxy-tee": ["mono", "fold"],
  "pima-vneck-tee": ["stack", "linen"],
  "oxford-button-down": ["linen", "fold"],
  "linen-camp-shirt": ["linen", "drape"],
  "flannel-overshirt": ["knit", "fold"],
  "slim-stretch-jeans": ["denim", "fold"],
  "relaxed-tapered-jeans": ["denim", "mono"],
  "raw-selvedge-jeans": ["denim", "drape"],
  "denim-trucker-jacket": ["denim", "fold"],
  "quilted-liner-jacket": ["mono", "fold"],
  "wool-topcoat": ["mono", "drape"],
  "merino-crew-sweater": ["knit", "stack"],
  "cable-knit-cardigan": ["knit", "drape"],
  "wrap-midi-dress": ["drape", "linen"],
  "tiered-linen-dress": ["linen", "drape"],
  "performance-joggers": ["mono", "stack"],
  "training-tech-tee": ["mono", "stack"],
  "seamless-leggings": ["mono", "drape"],
  "canvas-weekender": ["arc", "stack"],
  "leather-card-holder": ["stack", "mono"],
  "ribbed-beanie": ["knit", "stack"],
  "sample-capsule-hoodie": ["knit", "mono"],
};

await ensureBucket();
let seed = 10;
for (const [slug, kinds] of Object.entries(CATALOG)) {
  await upload(`${slug}/01.png`, encodePng(paint(kinds[0], seed++)));
  await upload(`${slug}/02.png`, encodePng(paint(kinds[1], seed++)));
  console.log(`uploaded ${slug} (2 tiles)`);
}
console.log("done:", Object.keys(CATALOG).length, "products");
