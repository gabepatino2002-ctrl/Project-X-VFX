// lottieAdapter.js
// LottieFiles adapter: search + import (download -> minify -> gzip -> upload to S3 or local cache)
// Requires: process.env.LOTTIE_API_KEY (LottieFiles v2 API key)
// Optional S3: process.env.S3_BUCKET, AWS_* credentials via env or IAM role
// Fallback: local cache directory if no S3 config

const fetch = require('node-fetch');
const fs = require('fs').promises;
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const gzip = promisify(zlib.gzip);
const crypto = require('crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const DEFAULT_CACHE_DIR = path.join(__dirname, 'cache', 'lottie');
const LOTTIE_BASE = process.env.LOTTIE_API_BASE || 'https://api.lottiefiles.com/v2'; // update if LottieFiles docs change

// S3 client (optional)
let s3;
if (process.env.S3_BUCKET) {
  s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
}

/** util: ensure cache dir exists */
async function ensureCacheDir() {
  await fs.mkdir(DEFAULT_CACHE_DIR, { recursive: true });
}

/** util: backoff retry helper */
async function retry(fn, times = 3, delayMs = 300) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt >= times) throw err;
      await new Promise(r => setTimeout(r, delayMs * attempt));
    }
  }
}

/**
 * Search LottieFiles animations
 * returns normalized array: { provider, providerId, title, type, thumbnail, preview, license, tags, score, meta }
 */
async function searchLottieFiles(query, { page = 1, per_page = 24 } = {}) {
  const key = process.env.LOTTIE_API_KEY;
  if (!key) {
    throw new Error('LOTTIE_API_KEY not configured in env');
  }
  // example endpoint: GET /v2/animations?query=...&page=1&per_page=...
  const url = `${LOTTIE_BASE}/animations?query=${encodeURIComponent(query)}&page=${page}&per_page=${per_page}`;
  const res = await retry(() => fetch(url, { headers: { Authorization: `Bearer ${key}` } }), 3, 300);
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`LottieFiles search failed: ${res.status} ${text}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  // LottieFiles API returns data array — normalize
  const items = (json.data || []).map(item => {
    // fields vary; adapt using best-effort mapping
    return {
      provider: 'lottiefiles',
      providerId: String(item.id || item._id || item.uid || item.uuid),
      title: item.title || item.name || 'Lottie',
      type: 'lottie',
      thumbnail: item.thumbnail || item.preview || (item.images && item.images.thumbnail),
      preview: item.preview || item.files?.json?.url || null,
      license: (item.license && item.license.name) || item.license || 'unknown',
      tags: item.tags || (item.meta && item.meta.tags) || [],
      score: 1.0, // base; you can compute better ranking later
      meta: {
        duration_ms: item.duration_ms || item.duration || null,
        frames: item.frames || null,
      },
    };
  });
  return {
    query,
    page: json.page || page,
    per_page: json.per_page || per_page,
    total: json.total || items.length,
    results: items
  };
}

/**
 * Import a Lottie animation (providerId) from LottieFiles:
 * - fetch details for animation -> find JSON download URL
 * - download JSON
 * - validate JSON (parseable)
 * - minify + gzip (optional)
 * - upload to S3 (if configured) or save to local cache
 * - return normalized manifest { id, displayName, requiredAssets: [{name,type,url,etag}], license, source }
 *
 * options: { generateTemplate: boolean, targetS3Bucket: (optional override) }
 */
async function importLottieAnimation(providerId, options = {}) {
  const key = process.env.LOTTIE_API_KEY;
  if (!key) {
    throw new Error('LOTTIE_API_KEY not configured in env');
  }
  // 1) Get animation details
  const detailUrl = `${LOTTIE_BASE}/animations/${encodeURIComponent(providerId)}`;
  const detailRes = await retry(() => fetch(detailUrl, { headers: { Authorization: `Bearer ${key}` } }), 3, 300);
  if (!detailRes.ok) {
    const txt = await detailRes.text();
    const e = new Error(`Lottie detail fetch failed ${detailRes.status}: ${txt}`);
    e.status = detailRes.status;
    throw e;
  }
  const detail = await detailRes.json();

  // 2) Find JSON download URL (try multiple fields)
  // common candidates: detail.files.json.url, detail.files['lottie.json'].url, detail.animation_url, detail.preview
  const candidateUrls = [];
  if (detail.files) {
    // files may be an object with various formats
    for (const k of Object.keys(detail.files)) {
      const entry = detail.files[k];
      if (!entry) continue;
      if (entry.url) candidateUrls.push(entry.url);
      if (entry.download_url) candidateUrls.push(entry.download_url);
    }
  }
  if (detail.animation_url) candidateUrls.push(detail.animation_url);
  if (detail.download_url) candidateUrls.push(detail.download_url);
  if (detail.preview) candidateUrls.push(detail.preview);
  // de-dup
  const urls = [...new Set(candidateUrls)].filter(Boolean);
  if (!urls.length) {
    throw new Error('No downloadable JSON/url discovered in provider metadata. Inspect detail object for available asset links.');
  }

  // pick first likely JSON (.json or .lottie)
  const jsonUrl = urls.find(u => u.endsWith('.json') || u.includes('json')) || urls[0];

  // 3) download animation JSON
  const animBuffer = await retry(async () => {
    const r = await fetch(jsonUrl, { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) throw new Error(`download failed ${r.status}`);
    return await r.buffer();
  }, 3, 400);

  // 4) validate + minify JSON
  let parsed;
  try {
    parsed = JSON.parse(animBuffer.toString('utf8'));
  } catch (err) {
    throw new Error('Downloaded file is not valid JSON: ' + err.message);
  }
  // Quick safety checks: size / allowed features could be added here
  const minified = JSON.stringify(parsed); // simple minify

  // 5) gzip
  const gz = await gzip(Buffer.from(minified), { level: zlib.constants.Z_BEST_COMPRESSION });

  // Generate stable-ish filename
  const hash = crypto.createHash('sha1').update(gz).digest('hex').slice(0, 12);
  const outName = `lottie_${providerId}_${hash}.json.gz`;
  const localPath = path.join(DEFAULT_CACHE_DIR, outName);
  await ensureCacheDir();
  await fs.writeFile(localPath, gz);

  // 6) upload to S3 if configured
  let remoteUrl = null;
  if (s3 && process.env.S3_BUCKET) {
    const bucket = options.targetS3Bucket || process.env.S3_BUCKET;
    const keyName = `lottie/${outName}`;
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: keyName,
      Body: gz,
      ContentType: 'application/json',
      ContentEncoding: 'gzip',
      ACL: 'public-read' // in many cases we prefer presigned URL vs public; change as needed
    }));
    // generate presigned URL (short lifetime)
    const signedUrl = await getSignedUrl(s3, new PutObjectCommand({
      Bucket: bucket,
      Key: keyName,
    }), { expiresIn: 60 * 60 }); // 1 hour signed PUT (not useful for GET)
    // If object is public-read, produce public url
    remoteUrl = `https://${bucket}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${encodeURIComponent(keyName)}`;
    // If you prefer presigned GET:
    // const getSigned = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: keyName }), { expiresIn: 60*60*24 });
    // remoteUrl = getSigned;
  } else {
    // fallback: local file path served by your API static route (not ideal for prod)
    // you should expose /cache/lottie/<filename> via express static
    remoteUrl = `file://${localPath}`;
  }

  // 7) build manifest
  const manifest = {
    id: `lottie_import_${providerId}_${hash}`,
    displayName: detail.title || detail.name || `Lottie ${providerId}`,
    version: detail.version || '1',
    license: (detail.license && detail.license.name) || detail.license || 'unknown',
    source: { provider: 'lottiefiles', providerId },
    requiredAssets: [
      {
        name: outName,
        type: 'lottie',
        mime: 'application/json',
        url: remoteUrl,
        localPath,
        size: gz.length,
        etag: hash
      }
    ],
    sequenceTemplate: options.generateTemplate ? generateDefaultSequenceTemplate(manifestIdFrom(providerId, hash)) : null,
    importedAt: new Date().toISOString(),
    rawDetail: detail // store for auditing (may be large)
  };

  return manifest;
}

function manifestIdFrom(providerId, hash) {
  return `lottie_import_${providerId}_${hash}`;
}

// small helper: default simple sequence template (client can edit)
function generateDefaultSequenceTemplate(effectId) {
  return {
    name: effectId,
    phases: [
      { time: 0, action: 'spawn', effect: 'lottie_charge', pos: 'attacker', duration: 600 },
      { time: 600, action: 'spawn', effect: 'lottie_projectile', pos: 'towards_target' },
      { time: 'onImpact', action: 'spawn', effect: 'lottie_impact', pos: 'target' }
    ],
    notes: 'Automatically generated template for imported Lottie. Edit in UI if you want bespoke timing.'
  };
}

module.exports = {
  searchLottieFiles,
  importLottieAnimation
};
