// DEV-ONLY: replace the generated rich-catalog tiles (seed-rich-product-media.mjs) with real clothing
// photos from Unsplash, so the Storefront can be judged with realistic imagery. Uploads to the same
// object paths (<slug>/01.png, <slug>/02.png), so no database change is needed. Not part of the
// product: production starts with an empty catalogue and the brand uploads its own photos.
//
// Photos are used under the Unsplash License (free, no attribution required); IDs are listed below so
// each can be traced back to unsplash.com/photos/<id>.
//
//   node scripts/seed-rich-product-photos.mjs              # download from Unsplash, then upload
//   node scripts/seed-rich-product-photos.mjs <dir>        # upload <dir>/<slug>-01.jpg etc. instead
//
// To go back to the generated tiles, run scripts/seed-rich-product-media.mjs again.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const STORAGE = "http://127.0.0.1:54321/storage/v1";
const BUCKET = "product-media";
// Well-known local Supabase demo service-role key (same as seed-rich-product-media.mjs).
const SERVICE_ROLE =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const CROP = "w=900&h=1125&fit=crop&crop=entropy&fm=jpg&q=80";
const DETAIL = "w=900&h=1125&fit=crop&crop=focalpoint&fp-x=0.5&fp-y=0.55&fp-z=1.8&fm=jpg&q=80";

/** slug -> [front photo, second photo]; a second entry of `{ id, detail: true }` is a close-up crop. */
const PHOTOS = {
  "performance-joggers": ["1789110853665-11a03e391f04", "1789110853737-e30e04cda364"],
  "canvas-weekender": ["1544816155-12df9643f363", { id: "1544816155-12df9643f363", detail: true }],
  "quilted-liner-jacket": ["1776774646358-e7a8a9063375", "1772817565731-cfae0f2c1552"],
  "cable-knit-cardigan": ["1579206464424-7e43a81cadc1", "1631669991586-0465d15a41f5"],
  "oxford-button-down": ["1791391279730-4756da7b4608", "1770058428099-f2d64ab34006"],
  "slim-stretch-jeans": ["1584370848010-d7fe6bc767ec", "1475178626620-a4d074967452"],
  "pima-vneck-tee": ["1586790170083-2f9ceadc732d", "1603364374348-890320e28dda"],
  "raw-selvedge-jeans": ["1725387072845-7431bbc453bc", "1770795945741-80b6f482f812"],
  "ribbed-beanie": ["1618354691792-d1d42acfd860", "1775805043561-832a11d75870"],
  "denim-trucker-jacket": ["1611312449408-fcece27cdbb7", "1614699745279-2c61bd9d46b5"],
  "training-tech-tee": ["1583743814966-8936f5b7be1a", "1747213848474-b89023221e20"],
  "relaxed-tapered-jeans": ["1602293589930-45aad59ba3ab", "1715758890151-2c15d5d482aa"],
  "merino-crew-sweater": ["1614975059251-992f11792b9f", "1604573824419-289a9a10672c"],
  "tiered-linen-dress": ["1747396206869-75ea57b325ce", "1764298493197-a1c1cce57800"],
  "leather-card-holder": ["1614330315526-166f2d71e544", "1627123424574-724758594e93"],
  "everyday-crew-tee": ["1581655353564-df123a1eb820", "1574180566232-aaad1b5b8450"],
  "wrap-midi-dress": ["1759992878340-665575a0832e", "1759992878336-a5dd342ea245"],
  "linen-camp-shirt": ["1591357037205-166318b51afd", "1617117475026-2eb3e68b63cf"],
  "seamless-leggings": ["1584863495140-a320b13a11a8", "1618355281951-a174b87198e2"],
  "heavyweight-boxy-tee": ["1627225924765-552d49cf47ad", "1627225793904-a2f900a6e4cf"],
  "flannel-overshirt": ["1782226728289-f81457b760f5", "1769867414844-d77ccb5b5543"],
  "wool-topcoat": ["1539533113208-f6df8cc8b543", "1620247405612-18f042ea68cf"],
};

const localDir = process.argv[2];

async function photoBytes(slug, index, entry) {
  if (localDir) return readFile(join(localDir, `${slug}-0${index + 1}.jpg`));
  const { id, detail } = typeof entry === "string" ? { id: entry, detail: false } : entry;
  const response = await fetch(`https://images.unsplash.com/photo-${id}?${detail ? DETAIL : CROP}`);
  const type = response.headers.get("content-type") ?? "";
  if (!response.ok || !type.startsWith("image/")) {
    throw new Error(`${slug}: download failed (${response.status} ${type})`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function upload(path, bytes) {
  const response = await fetch(`${STORAGE}/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SERVICE_ROLE}`,
      "Content-Type": "image/jpeg",
      "x-upsert": "true",
      "cache-control": "no-cache",
    },
    body: bytes,
  });
  if (!response.ok)
    throw new Error(`${path}: upload failed ${response.status} ${await response.text()}`);
}

let count = 0;
for (const [slug, entries] of Object.entries(PHOTOS)) {
  for (const [index, entry] of entries.entries()) {
    // Keep the seeded .png object names so the catalogue rows stay valid; the bytes are JPEG and
    // are served with an image/jpeg content type.
    await upload(`${slug}/0${index + 1}.png`, await photoBytes(slug, index, entry));
    count++;
  }
}
console.log(`Uploaded ${count} product photos to ${BUCKET}.`);
