#!/usr/bin/env node
/**
 * Sketchfab Model Downloader
 * Usage: node download.js <sketchfab_url_or_uid> [output.glb]
 *
 * Downloads, decrypts, descrambles textures, and converts to glTF 2.0 GLB.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');

// ─── Config ───────────────────────────────────────────────────────────────────

const STATIC_KEY = "77d92dd656ac3fdde472d5ba59747f42ac0ce217";
const WORK_DIR = path.join(__dirname, '.cache');

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function fetch(url) {
    return new Promise((resolve, reject) => {
        const get = url.startsWith('https') ? https.get : require('http').get;
        get(url, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetch(res.headers.location).then(resolve, reject);
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        }).on('error', reject);
    });
}

function fetchText(url) { return fetch(url).then(b => b.toString('utf8')); }

// ─── Step 1: Parse embed page ─────────────────────────────────────────────────

async function getModelConfig(uid) {
    console.log(`[1/6] Fetching embed page...`);
    const html = (await fetchText(`https://sketchfab.com/models/${uid}/embed`)).replace(/&#34;/g, '"');

    const pMatch = html.match(/"p"\s*:\s*\[\{[^}]*"v"\s*:\s*(\d+)[^}]*"b"\s*:\s*"([^"]+)"/);
    const binzMatch = html.match(/https:\/\/media\.sketchfab\.com\/models\/[^"]*\/files\/[^"]*\/file\.binz/);
    if (!pMatch || !binzMatch) throw new Error('Could not extract model config');

    const baseUrl = binzMatch[0].replace(/\/file\.binz$/, '');

    // Extract material channels with texture UIDs
    let channels = {};
    for (const chName of ['AlbedoPBR', 'EmitColor', 'NormalMap', 'MetalnessPBR', 'RoughnessPBR']) {
        const re = new RegExp(`"${chName}"[\\s\\S]*?"texture"[\\s\\S]*?"uid"\\s*:\\s*"([a-f0-9]+)"`);
        const m = html.match(re);
        if (m) channels[chName] = m[1];
    }

    // Extract texture entries: uid → {url, pk, width}
    // Each entry has nested objects, so use [\s\S] to cross } boundaries
    const texEntries = {};
    const texPattern = /"uid":\s*"([^"]+)"[\s\S]*?"width":\s*(\d+)[\s\S]*?"url":\s*"([^"]+)"[\s\S]*?"pk":\s*(\d+)/g;
    let tm;
    while ((tm = texPattern.exec(html)) !== null) {
        const [, uid2, w, url, pk] = tm;
        const setMatch = url.match(/\/textures\/([^/]+)\//);
        if (!setMatch) continue;
        const setUid = setMatch[1];
        const key = `${setUid}_${w}`;
        if (!texEntries[key] || parseInt(w) > texEntries[key].width) {
            texEntries[key] = { setUid, url, pk: parseInt(pk), width: parseInt(w), filename: url.split('/').pop() };
        }
    }

    // Map channels to best (largest) texture files
    const textureMap = {};
    for (const [chName, setUid] of Object.entries(channels)) {
        let best = null;
        for (const e of Object.values(texEntries)) {
            if (e.setUid === setUid && (!best || e.width > best.width)) best = e;
        }
        if (best) textureMap[chName] = best;
    }

    return {
        uid, baseUrl, html,
        diterB: pMatch[2],
        diterV: parseInt(pMatch[1]),
        textureMap
    };
}

// ─── Step 2: Download files ───────────────────────────────────────────────────

async function downloadFiles(config) {
    console.log(`[2/6] Downloading model files...`);
    fs.mkdirSync(path.join(WORK_DIR, 'textures'), { recursive: true });

    const files = {
        'file.binz': `${config.baseUrl}/file.binz`,
        'model_file.binz': `${config.baseUrl}/model_file.binz`,
        'model_file_wireframe.binz': `${config.baseUrl}/model_file_wireframe.binz`,
    };

    for (const [name, url] of Object.entries(files)) {
        const dest = path.join(WORK_DIR, name);
        if (!fs.existsSync(dest)) {
            const data = await fetch(url);
            fs.writeFileSync(dest, data);
            console.log(`  ${name}: ${data.length} bytes`);
        }
    }

    // Download textures
    for (const [ch, tex] of Object.entries(config.textureMap)) {
        const dest = path.join(WORK_DIR, 'textures', tex.filename);
        if (!fs.existsSync(dest)) {
            const data = await fetch(tex.url);
            fs.writeFileSync(dest, data);
            console.log(`  ${ch} texture: ${data.length} bytes`);
        }
    }
}

// ─── Step 2.5: Extract decrypt.wasm from viewer JS ───────────────────────────

const WASM_PATH = path.join(__dirname, 'decrypt.wasm');

async function ensureWasm(embedHtml) {
    if (fs.existsSync(WASM_PATH)) return;

    console.log(`[*] Extracting decrypt.wasm from viewer bundles...`);

    // Find all JS bundle URLs from embed page
    const bundleUrls = [...new Set(
        (embedHtml.match(/https:\/\/static\.sketchfab\.com\/static\/builds\/web\/dist\/[^"&]+\.js/g) || [])
    )];

    if (!bundleUrls.length) throw new Error('No viewer JS bundles found in embed page');

    // Search each bundle for the WASM base64 (starts with AGFzbQ = \x00asm)
    for (const url of bundleUrls) {
        const js = (await fetch(url)).toString('utf8');
        const wasmIdx = js.indexOf('AGFzbQ');
        if (wasmIdx === -1) continue;

        // Find the enclosing quotes
        let start = js.lastIndexOf('"', wasmIdx) + 1;
        let end = wasmIdx;
        while (end < js.length) {
            if (js[end] === '"' && js[end - 1] !== '\\') break;
            end++;
        }

        const b64 = js.substring(start, end).replace(/\\n/g, '');
        const wasmBytes = Buffer.from(b64, 'base64');

        if (wasmBytes[0] === 0x00 && wasmBytes[1] === 0x61 && wasmBytes[2] === 0x73 && wasmBytes[3] === 0x6d) {
            fs.writeFileSync(WASM_PATH, wasmBytes);
            console.log(`  decrypt.wasm: ${wasmBytes.length} bytes (from ${url.split('/').pop()})`);
            return;
        }
    }

    throw new Error('Could not find WASM decryption module in viewer bundles');
}

// ─── Step 2.6: Extract static key from viewer JS ─────────────────────────────

async function extractStaticKey(embedHtml) {
    const bundleUrls = [...new Set(
        (embedHtml.match(/https:\/\/static\.sketchfab\.com\/static\/builds\/web\/dist\/[^"&]+\.js/g) || [])
    )];

    for (const url of bundleUrls) {
        const js = (await fetch(url)).toString('utf8');
        const match = js.match(/exports\s*\.\s*k\s*:\s*\(\)\s*=>\s*\w+\}\s*;\s*const\s+\w+\s*=\s*"([0-9a-f]{40})\\n"/);
        if (match) return match[1];
        const match2 = js.match(/\{k:\s*\(\)\s*=>\s*\w+\}[^;]*;\s*const\s+\w+\s*=\s*"([0-9a-f]{40})/);
        if (match2) return match2[1];
    }

    return STATIC_KEY; // fallback to hardcoded
}

// ─── Step 3: WASM decryption ──────────────────────────────────────────────────

function parseWasmDataSize(wasmBytes) {
    let m = 65536, d = 8;
    while (d < wasmBytes.length) {
        const v = () => wasmBytes[d++];
        const w = () => { let t = d, n = 0, e = 128; while (128 & e) { e = wasmBytes[d]; n |= (127 & e) << (7 * (d - t)); d++; } return n; };
        let y = w(), I = w(), h = d + I;
        if (y < 0 || y > 11 || I <= 0 || h > wasmBytes.length) break;
        if (6 === y) { w(); v(); v(); w(); let _ = w(); v(); m = _; }
        if (11 === y) { for (let Z = w(), A = 0; A !== Z && d < h; A++) { v(); w(); w(); w(); let U = w(); d += U; } }
        d = h;
    }
    return m;
}

async function initWasm() {
    const wasmPath = WASM_PATH;
    if (!fs.existsSync(wasmPath)) throw new Error('decrypt.wasm not found — run ensureWasm first');
    const wasmBytes = fs.readFileSync(wasmPath);
    const r = new Uint8Array(wasmBytes);
    const m = parseWasmDataSize(r);
    const g = 262144 + ((m + 65535) >> 16 << 16);
    let currentBreak = m;
    const memory = new WebAssembly.Memory({ initial: g >> 16, maximum: 536870912 >> 16, shared: false });
    let u8 = new Uint8Array(memory.buffer), u32 = new Uint32Array(memory.buffer);
    const refresh = () => { u8 = new Uint8Array(memory.buffer); u32 = new Uint32Array(memory.buffer); };
    const env = {
        sbrk(inc) { const old = currentBreak; currentBreak += inc; const ov = currentBreak - memory.buffer.byteLength; if (ov > 0) { memory.grow((ov + 65535) >> 16); refresh(); } return old | 0; },
        time(t) { const r = Date.now() / 1000 | 0; if (t) u32[t >> 2] = r; return r; },
        gettimeofday(t) { const n = Date.now(); u32[t >> 2] = n / 1000 | 0; u32[(t + 4) >> 2] = n % 1000 * 1000 | 0; },
        abort() { throw new Error('WASM abort'); },
        memory
    };
    env.__lock = env.__unlock = env.setjmp = env.__cxa_atexit = () => {};
    const result = await WebAssembly.instantiate(r, { env });
    const ex = result.instance.exports;
    if (ex.__wasm_call_ctors) ex.__wasm_call_ctors();
    return { a: ex, H: () => { refresh(); return u8; }, memory };
}

async function decryptBinz(binzPath, diterB, staticKey) {
    const encData = fs.readFileSync(binzPath);
    const wasm = await initWasm();
    const a = wasm.a;

    const allocInput = a['heSBnb29kYnllCk5ldmVyIGdvbm5hIHRl'];
    const reset = a['mV2ZXIgZ29ubmEgbGV0IHlvdSBkb3duCk5l'];
    const rickRolled = a['Umlja1JvbGxlZDRV'];
    const allocDiterB = a['dmVyIGdvbm5hIHJ1biBhcm91bmQgYW5kI'];
    const process_ = a['GRlc2VydCB5b3UKTmV2ZXIgZ29ubmEgbW'];
    const advance = a['FrZSB5b3UgY3J5Ck5ldmVyIGdvbm5hIHN'];
    const getInfo = a['bGwgYSBsaWUgYW5kIGh1cnQgeW91Cg'];
    const getStart = a['TmV2ZXIgZ29ubmEgZ2l2ZSB5b3UgdXAKT'];

    // Key setup
    const keyHex = (staticKey || STATIC_KEY).slice(0, 40).toLowerCase();
    const seed = 1314 + Math.floor(9999 * Math.random());
    const collected = [];
    let running = seed;
    for (let i = 0; i < 10; i++) {
        const G = parseInt(keyHex.slice(4 * i, 4 * i + 4), 16);
        running ^= G;
        collected.push(G ^ seed);
        collected.push(running);
    }
    let xorAll = collected[19];
    for (let t = 0; t < 10; t++) xorAll ^= collected[2 * t];
    const keyArr = Array.from({ length: 10 }, (_, t) => collected[2 * t] ^ xorAll);
    const keyOff = rickRolled(seed, 40);
    let mem = wasm.H();
    for (let t = 0; t < 10; t++) {
        let h = keyArr[t].toString(16); h = "0".repeat(4 - h.length) + h;
        for (let n = 0; n < h.length; n++) mem[keyOff + n + 4 * t] = h.charCodeAt(n);
    }

    const diterBClean = diterB.replace(/\\n/g, '').replace(/\n/g, '');
    const diterBBytes = Buffer.from(diterBClean, 'base64');
    reset();
    const dOff = allocDiterB(diterBBytes.length);
    mem = wasm.H();
    for (let i = 0; i < diterBBytes.length; i++) mem[dOff + i] = diterBBytes[i];
    process_(0);

    const input = new Uint8Array(encData);
    const chunks = [];
    for (let off = 0; off < input.length; off += 10240) {
        const len = Math.min(10240, input.length - off);
        const iOff = allocInput(len);
        mem = wasm.H();
        for (let i = 0; i < len; i++) mem[iOff + i] = input[off + i];
        let more = process_(1);
        while (more) {
            mem = wasm.H();
            const s = getStart(), e = getStart() + getInfo();
            chunks.push(Buffer.from(mem.subarray(s, e).slice(0)));
            advance();
            more = process_(0);
        }
    }
    let result = Buffer.concat(chunks);
    if (result[0] === 0x1f && result[1] === 0x8b) result = zlib.gunzipSync(result);
    return result;
}

async function decryptAll(config) {
    console.log(`[3/6] Decrypting model files...`);
    const names = ['file.binz', 'model_file.binz', 'model_file_wireframe.binz'];
    const outputs = ['file.osgjs', 'model_file.bin', 'model_file_wireframe.bin'];
    for (let i = 0; i < names.length; i++) {
        const src = path.join(WORK_DIR, names[i]);
        const dst = path.join(WORK_DIR, outputs[i]);
        if (fs.existsSync(dst)) continue;
        const result = await decryptBinz(src, config.diterB, config.staticKey);
        fs.writeFileSync(dst, result);
        console.log(`  ${outputs[i]}: ${result.length} bytes`);
    }
}

// ─── Step 4: Texture descrambling ─────────────────────────────────────────────

function mod(i, u) { const y = Math.floor(i / u); return i - y * u; }

function triSum(y, t, f) {
    const x = Math.min(y, t), n = Math.max(y, t);
    if (f < x) return f * (f + 1) / 2;
    if (f < n) return x * (x + 1) / 2 + x * (f - x);
    const r = f - n;
    return x * (x + 1) / 2 + x * (n - x) + (x - 1) * r - (r - 1) * r / 2;
}

function xyToZigzag(gw, gh, px, py) {
    const r = Math.min(gw, gh), n = Math.max(gw, gh), v = px + py, h = mod(v, 2) === 0;
    if (v < r) return triSum(gw, gh, v) + (h ? v - py : py);
    if (v < n) {
        let s = gh - py - 1;
        if (gw < gh) s = r - (gw - px);
        return triSum(gw, gh, v) + (h ? s : r - s - 1);
    }
    const s = gh - py - 1, e = r + n - v - 1;
    return triSum(gw, gh, v) + (h ? s : e - s - 1);
}

function zigzagToXy(gw, gh, idx) {
    const v = Math.min(gw, gh), r = Math.max(gw, gh);
    const t1 = v * (v + 1) / 2, t2 = t1 + v * (r - v);
    if (idx < t1) {
        const n = Math.floor((-1 + Math.sqrt(8 * idx + 1)) / 2);
        const h = idx - triSum(gw, gh, n);
        return mod(n, 2) === 0 ? [h, n - h] : [n - h, h];
    }
    if (idx < t2) {
        const x2 = idx - t1, n = v + Math.floor(x2 / v), s = mod(x2, v), h = mod(n, 2) === 0;
        const g = n - v + s + 1, e = v - s - 1, S = n - s, T = s;
        if (gw > gh) return h ? [g, e] : [S, T];
        return h ? [T, S] : [e, g];
    }
    const n2 = v * (v - 1) / 2 - (idx - t2) - 1;
    const s2 = Math.floor((-1 + Math.sqrt(8 * n2 + 1)) / 2);
    const n = r + v - s2 - 2;
    let h2 = idx - triSum(gw, gh, n);
    const e2 = v + r - n - 1;
    if (mod(n, 2) === 0) h2 = e2 - h2 - 1;
    const S2 = n + h2 - gw + 1;
    return [n - S2, S2];
}

function pixelToBlockIdx(x, y, bw, bh) {
    const bi = xyToZigzag(bw, bh, Math.floor(x / 8), Math.floor(y / 8));
    const rot = mod(bi, 4);
    let px = mod(x, 8), py = mod(y, 8);
    if (rot === 1) px = 7 - px;
    else if (rot === 2) { const t = px; px = py; py = t; }
    else if (rot === 3) { const t = px; px = 7 - py; py = t; }
    return bi * 64 + px + py * 8;
}

function blockIdxToPixel(idx, w, h) {
    const bw = w / 8, bh = h / 8;
    const bi = Math.floor(idx / 64), intra = idx - bi * 64;
    const iy = Math.floor(intra / 8), ix = intra - iy * 8;
    const rot = mod(bi, 4);
    const bp = zigzagToXy(bw, bh, bi);
    let px = bp[0] * 8, py = bp[1] * 8;
    if (rot === 0) { px += ix; py += iy; }
    else if (rot === 1) { px += 7 - ix; py += iy; }
    else if (rot === 2) { px += iy; py += ix; }
    else if (rot === 3) { px += iy; py += 7 - ix; }
    return [px, py];
}

function descrambleTexture(imgBuf, w, h, channels, pk) {
    const total = w * h;
    const offset = ((-pk) * 64) % total + ((-pk * 64 % total < 0) ? total : 0);
    const bw = w / 8, bh = h / 8;

    // Build forward map: for each pixel position, compute its block index
    const blockMap = new Int32Array(total);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            blockMap[y * w + x] = pixelToBlockIdx(x, y, bw, bh);
        }
    }

    // Build inverse map
    const invX = new Int32Array(total);
    const invY = new Int32Array(total);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const fi = blockMap[y * w + x];
            invX[fi] = x;
            invY[fi] = y;
        }
    }

    // Apply permutation
    const result = Buffer.alloc(imgBuf.length);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const fi = blockMap[y * w + x];
            let shifted = (fi + offset) % total;
            if (shifted < 0) shifted += total;
            const sx = invX[shifted], sy = invY[shifted];
            const dstOff = (y * w + x) * channels;
            const srcOff = (sy * w + sx) * channels;
            for (let c = 0; c < channels; c++) result[dstOff + c] = imgBuf[srcOff + c];
        }
    }
    return result;
}

async function descrambleTextures(config) {
    console.log(`[4/6] Descrambling textures...`);
    // Use sharp or jimp for image decode. Fall back to raw decode.
    let decodeImage, encodeImage;
    try {
        const sharp = require('sharp');
        decodeImage = async (p) => {
            const meta = await sharp(p).metadata();
            const raw = await sharp(p).removeAlpha().ensureAlpha(0).raw().toBuffer();
            return { data: raw, width: meta.width, height: meta.height, channels: meta.channels || 3 };
        };
        encodeImage = async (buf, w, h, ch, outPath) => {
            await sharp(buf, { raw: { width: w, height: h, channels: ch } })
                .toFormat(outPath.endsWith('.png') ? 'png' : 'jpeg', { quality: 95 })
                .toFile(outPath);
        };
    } catch (e) {
        // Fallback: use the scrambled textures as-is (user can descramble separately)
        console.log('  sharp not available — install with: npm install sharp');
        console.log('  Using scrambled textures (run descramble.py separately)');
        return config.textureMap;
    }

    // Build block maps once for the largest texture size
    let cachedBlockMap = null, cachedW = 0, cachedH = 0;

    const cleanMap = {};
    for (const [chName, tex] of Object.entries(config.textureMap)) {
        const srcPath = path.join(WORK_DIR, 'textures', tex.filename);
        const ext = tex.filename.endsWith('.png') ? '.png' : '.jpeg';
        const cleanName = chName.toLowerCase() + '_clean' + ext;
        const dstPath = path.join(WORK_DIR, 'textures', cleanName);

        if (fs.existsSync(dstPath)) {
            cleanMap[chName] = { ...tex, cleanFile: cleanName };
            continue;
        }

        const img = await decodeImage(srcPath);
        console.log(`  ${chName}: ${img.width}x${img.height} pk=${tex.pk}`);
        const descrambled = descrambleTexture(img.data, img.width, img.height, img.channels, tex.pk);
        await encodeImage(descrambled, img.width, img.height, img.channels, dstPath);
        cleanMap[chName] = { ...tex, cleanFile: cleanName };
        console.log(`    → ${cleanName}`);
    }
    return cleanMap;
}

// ─── Step 5: osgjs → glTF conversion ─────────────────────────────────────────

function decodeVarint(bytes, count, signed) {
    const result = signed ? new Int32Array(count) : new Uint32Array(count);
    let a = 0, o = 0;
    while (a < count) {
        let s = 0, l = 0;
        do { s |= (bytes[o] & 127) << l; l += 7; } while ((bytes[o++] & 128) !== 0);
        result[a++] = s;
    }
    if (signed) for (let u = 0; u < count; u++) { const c = result[u]; result[u] = (c >> 1) ^ -(c & 1); }
    return result;
}

function deltaDecode(arr, start) {
    let prev = arr[start || 0];
    for (let i = (start || 0) + 1; i < arr.length; i++) { const v = arr[i]; prev = arr[i] = prev + (v >> 1 ^ -(v & 1)); }
    return arr;
}

function dequantize(enc, out, bbl, h, itemSize) {
    const n = enc.length / itemSize;
    for (let i = 0; i < n; i++) { const b = i * itemSize; for (let j = 0; j < itemSize; j++) out[b + j] = bbl[j] + enc[b + j] * h[j]; }
    return out;
}

function decodeNormals(enc, out, itemSize, eps, nphi) {
    eps = eps || 0.25; nphi = nphi || 720;
    const PI = 3.14159265359, cosEps = Math.cos(0.01745329251 * eps);
    const dPhi = PI / (nphi - 1), dGamma = 1.57079632679 / (nphi - 1);
    const count = enc.length / 2;
    for (let i = 0; i < count; i++) {
        const oi = i * itemSize, ii = i * 2;
        let S = enc[ii], x = enc[ii + 1];
        if (itemSize === 4) { out[oi + 3] = (S & 1024) ? -1 : 1; S &= ~1024; }
        const A0 = S * dPhi, R = Math.cos(A0), w = Math.sin(A0), A1 = A0 + dGamma;
        let E = (cosEps - R * Math.cos(A1)) / Math.max(1e-5, w * Math.sin(A1));
        if (E > 1) E = 1; else if (E < -1) E = -1;
        const P = 6.28318530718 * x / Math.ceil(PI / Math.max(1e-5, Math.acos(E)));
        out[oi] = w * Math.cos(P); out[oi + 1] = w * Math.sin(P); out[oi + 2] = R;
    }
    return out;
}

function implicitDecode(enc, output, startIdx, useExpected) {
    let r = enc[2]; const maskLen = enc[1], mv = enc.subarray(3, 3 + maskLen);
    const masks = new Uint32Array(mv.buffer, mv.byteOffset, maskLen);
    let idx = startIdx; const pad = maskLen * 32 - output.length;
    for (let u = 0; u < maskLen; u++) {
        const c = masks[u]; let h = u * 32;
        for (let d = (u === maskLen - 1 ? pad : 0); d < 32; d++, h++) {
            if (h >= output.length) break;
            output[h] = (c & ((-2147483648) >>> d)) ? enc[idx++] : (useExpected ? r : r++);
        }
    }
    return output;
}

function expectedRenumber(arr, state) {
    let n = state[0];
    for (let a = 0; a < arr.length; a++) { const o = n - arr[a]; arr[a] = o; if (n <= o) n = o + 1; }
    state[0] = n;
    return arr;
}

// Index buffers narrower than 32-bit must be widened before delta/watermark
// decode, otherwise the arithmetic wraps around (e.g. a Uint8 index buffer).
function widenIndices(arr) {
    if (arr instanceof Uint32Array || arr instanceof Int32Array) return arr;
    return Int32Array.from(arr);
}

function parallelogramPredict(data, itemSize, strip) {
    const visited = new Uint8Array(data.length / itemSize);
    visited[strip[0]] = visited[strip[1]] = visited[strip[2]] = 1;
    for (let i = 2; i < strip.length - 1; i++) {
        const a = strip[i - 2], b = strip[i - 1], c = strip[i], d = strip[i + 1];
        if (visited[d] !== 1) {
            visited[d] = 1;
            for (let j = 0; j < itemSize; j++) data[d * itemSize + j] += data[b * itemSize + j] + data[c * itemSize + j] - data[a * itemSize + j];
        }
    }
    return data;
}

function stripToTris(indices) {
    const tris = [];
    for (let i = 0; i < indices.length - 2; i++) {
        const a = indices[i], b = indices[i + 1], c = indices[i + 2];
        if (a === b || b === c || a === c) continue;
        if (i % 2 === 0) tris.push(a, b, c); else tris.push(b, a, c);
    }
    return new Uint32Array(tris);
}

function looseToTris(indices) {
    const tris = [];
    for (let i = 0; i + 2 < indices.length; i += 3) {
        const a = indices[i], b = indices[i + 1], c = indices[i + 2];
        if (a === b || b === c || a === c) continue;
        tris.push(a, b, c);
    }
    return new Uint32Array(tris);
}

function readBuf(bin, vb, itemSize, typeName) {
    const off = vb.Offset || 0, size = vb.Size;
    if (vb.Encoding === 'varint') return decodeVarint(new Uint8Array(bin, off), size * itemSize, typeName[0] !== 'U');
    const types = { Float32Array, Int32Array, Uint32Array, Uint16Array, Uint8Array, Int16Array };
    return new types[typeName](bin, off, size * itemSize);
}

function buildUidMap(obj, map) {
    if (!obj || typeof obj !== 'object') return;
    if (obj.UniqueID !== undefined && Object.keys(obj).length > 1) map[obj.UniqueID] = obj;
    for (const v of Object.values(obj)) {
        if (Array.isArray(v)) v.forEach(c => buildUidMap(c, map));
        else if (typeof v === 'object') buildUidMap(v, map);
    }
}

function resolveRefs(obj, uidMap) {
    if (!obj || typeof obj !== 'object') return obj;
    if (obj.UniqueID !== undefined && Object.keys(obj).length === 1 && uidMap[obj.UniqueID]) return uidMap[obj.UniqueID];
    for (const [k, v] of Object.entries(obj)) {
        if (Array.isArray(v)) obj[k] = v.map(c => typeof c === 'object' ? resolveRefs(c, uidMap) : c);
        else if (typeof v === 'object') obj[k] = resolveRefs(v, uidMap);
    }
    return obj;
}

function convertToGltf(osgjs, polyBin, wireBin, textureFiles) {
    console.log(`[5/6] Converting to glTF...`);
    const uidMap = {}; buildUidMap(osgjs, uidMap); resolveRefs(osgjs, uidMap);

    const geometries = [];
    const seen = new Set();

    function processGeom(geom) {
        const meta = {};
        if (geom.UserDataContainer && geom.UserDataContainer.Values)
            for (const v of geom.UserDataContainer.Values) meta[v.Name] = isNaN(Number(v.Value)) ? v.Value : Number(v.Value);

        let stripIndices = null;
        const triChunks = [];
        // The "expected"/high-watermark counter is shared across all of a
        // geometry's primitives and processed in list order: the strip advances
        // it, then the loose-triangle set continues from the same value. Using a
        // fresh counter per primitive corrupts the loose-triangle indices.
        const expState = [0];
        const tm = meta.triangle_mode || 0;
        const hasTriAttr = (meta.attributes || 0) & 16;
        for (const prim of (geom.PrimitiveSetList || [])) {
            const dt = Object.keys(prim)[0], draw = prim[dt];
            if (!draw.Indices) continue;
            if (draw.Mode !== 'TRIANGLE_STRIP' && draw.Mode !== 'TRIANGLES') continue;
            const ai = draw.Indices.Array, at = Object.keys(ai)[0], ad = ai[at];
            const bin = ad.File && ad.File.includes('wireframe') ? wireBin : polyBin;
            if (!bin) continue;
            const isStrip = draw.Mode === 'TRIANGLE_STRIP';
            let idx = widenIndices(readBuf(bin.buffer, { ...ad, ItemSize: 1 }, 1, at));

            if (!hasTriAttr) {
                // Indices stored directly (not delta/watermark encoded).
                if (isStrip) { stripIndices = idx; triChunks.push(stripToTris(idx)); }
                else triChunks.push(looseToTris(idx));
                continue;
            }

            let out = idx, start = 0;
            if ((tm & 4) && isStrip) {
                start = 3 + idx[1];
                out = new Int32Array(idx[0]);
            }
            if (tm & 1) deltaDecode(idx, start);
            if ((tm & 4) && isStrip) implicitDecode(idx, out, start, !!(tm & 2));
            if (tm & 2) expectedRenumber(out, expState);

            if (isStrip) { stripIndices = out; triChunks.push(stripToTris(out)); }
            else triChunks.push(looseToTris(out));
        }
        let total = 0; for (const c of triChunks) total += c.length;
        if (!total) return null;
        const indices = new Uint32Array(total);
        { let o = 0; for (const c of triChunks) { indices.set(c, o); o += c.length; } }

        const attrs = {};
        const vaList = geom.VertexAttributeList || {};
        for (const [name, def] of Object.entries(vaList)) {
            const ai = def.Array; if (!ai) continue;
            const at = Object.keys(ai)[0], ad = ai[at];
            const bin = ad.File && ad.File.includes('wireframe') ? wireBin : polyBin;
            if (!bin) continue;
            const itemSize = def.ItemSize || 1;
            let data = readBuf(bin.buffer, { ...ad, ItemSize: itemSize }, itemSize, at);
            const count = ad.Size, af = meta.attributes || 0;

            if (name === 'Vertex') {
                const vm = meta.vertex_mode || 0;
                if ((vm & 2) && stripIndices) parallelogramPredict(data, itemSize, stripIndices);
                const pfx = 'vtx_';
                if (meta[pfx + 'bbl_x'] !== undefined) {
                    const bbl = [meta[pfx + 'bbl_x'], meta[pfx + 'bbl_y']]; const h = [meta[pfx + 'h_x'], meta[pfx + 'h_y']];
                    if (itemSize === 3) { bbl.push(meta[pfx + 'bbl_z']); h.push(meta[pfx + 'h_z']); }
                    data = dequantize(data, new Float32Array(data.length), bbl, h, itemSize);
                }
                attrs.POSITION = { data, itemSize, count };
            } else if (name === 'Normal' && (af & 2)) {
                attrs.NORMAL = { data: decodeNormals(data, new Float32Array(count * 3), 3, meta.epsilon, meta.nphi), itemSize: 3, count };
            } else if (name === 'Tangent' && (af & 32)) {
                attrs.TANGENT = { data: decodeNormals(data, new Float32Array(count * 4), 4, meta.epsilon, meta.nphi), itemSize: 4, count };
            } else if (name.startsWith('TexCoord')) {
                const suf = name.replace('TexCoord', ''), pfx = `uv_${suf}_`;
                const um = meta[`uv_${suf}_mode`] !== undefined ? meta[`uv_${suf}_mode`] : (meta.vertex_mode || 0);
                if ((um & 2) && stripIndices) parallelogramPredict(data, itemSize, stripIndices);
                if (meta[pfx + 'bbl_x'] !== undefined) {
                    const bbl = [meta[pfx + 'bbl_x'], meta[pfx + 'bbl_y']], h = [meta[pfx + 'h_x'], meta[pfx + 'h_y']];
                    data = dequantize(data, new Float32Array(data.length), bbl, h, itemSize);
                } else if (!(data instanceof Float32Array)) data = new Float32Array(data);
                for (let i = 1; i < data.length; i += (itemSize || 2)) data[i] = 1.0 - data[i];
                attrs[`_TC_${suf}`] = { data, itemSize: itemSize || 2, count };
            } else if (name === 'Color') {
                if (data instanceof Uint8Array) attrs.COLOR_0 = { data, itemSize: itemSize || 4, count, normalized: true, componentType: 5121 };
                else attrs.COLOR_0 = { data: new Float32Array(data), itemSize: itemSize || 4, count };
            }
        }

        // Remap TexCoords to continuous
        const tcKeys = Object.keys(attrs).filter(k => k.startsWith('_TC_')).sort();
        let tcIdx = 0;
        for (const k of tcKeys) { attrs[`TEXCOORD_${tcIdx++}`] = attrs[k]; delete attrs[k]; }

        return { name: geom.Name || 'mesh', indices, attributes: attrs };
    }

    function traverse(obj) {
        if (!obj || typeof obj !== 'object') return;
        if (obj['osg.Geometry']) {
            const g = obj['osg.Geometry'];
            if ((g.PrimitiveSetList || []).some(p => Object.values(p)[0] && Object.values(p)[0].Mode === 'LINES')) return;
            if (g.UniqueID !== undefined) { if (seen.has(g.UniqueID)) return; seen.add(g.UniqueID); }
            try { const r = processGeom(g); if (r && r.indices && r.attributes.POSITION) geometries.push(r); }
            catch (e) { console.warn(`  Warning: ${g.Name}: ${e.message}`); }
        }
        const ch = (obj['osg.Node'] && obj['osg.Node'].Children) || (obj['osg.MatrixTransform'] && obj['osg.MatrixTransform'].Children) || obj.Children;
        if (ch) for (const c of ch) traverse(c);
    }

    traverse(osgjs);
    console.log(`  ${geometries.length} geometries found`);

    // Build GLB
    const gltf = {
        asset: { version: '2.0', generator: 'sketchfab-downloader' },
        scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'root' }],
        meshes: [{ primitives: [] }], accessors: [], bufferViews: [], buffers: [],
        materials: [], textures: [], images: [], samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }]
    };

    const binChunks = [];
    let byteOffset = 0;

    function addAccessor(data, componentType, count, itemSize, normalized) {
        const typeMap = { 1: 'SCALAR', 2: 'VEC2', 3: 'VEC3', 4: 'VEC4' };
        const ctMap = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array };
        const buf = new (ctMap[componentType] || Float32Array)(data.buffer ? data : Array.from(data));
        const bytes = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
        const padded = Buffer.alloc(Math.ceil(bytes.length / 4) * 4); bytes.copy(padded);
        const bvIdx = gltf.bufferViews.length;
        gltf.bufferViews.push({ buffer: 0, byteOffset, byteLength: bytes.length });
        const min = [], max = [];
        for (let j = 0; j < itemSize; j++) { min.push(Infinity); max.push(-Infinity); }
        for (let i = 0; i < count; i++) for (let j = 0; j < itemSize; j++) {
            const v = buf[i * itemSize + j]; if (v < min[j]) min[j] = v; if (v > max[j]) max[j] = v;
        }
        const accIdx = gltf.accessors.length;
        gltf.accessors.push({ bufferView: bvIdx, byteOffset: 0, componentType, count, type: typeMap[itemSize] || 'SCALAR', min, max, ...(normalized ? { normalized: true } : {}) });
        binChunks.push(padded); byteOffset += padded.length;
        return accIdx;
    }

    function addImage(filePath) {
        if (!fs.existsSync(filePath)) return -1;
        const imgData = fs.readFileSync(filePath);
        const mime = filePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
        const padded = Buffer.alloc(Math.ceil(imgData.length / 4) * 4); imgData.copy(padded);
        gltf.bufferViews.push({ buffer: 0, byteOffset, byteLength: imgData.length });
        byteOffset += padded.length; binChunks.push(padded);
        const idx = gltf.images.length;
        gltf.images.push({ bufferView: gltf.bufferViews.length - 1, mimeType: mime });
        return idx;
    }

    function addTexture(filePath) {
        const imgIdx = addImage(filePath);
        if (imgIdx < 0) return -1;
        const texIdx = gltf.textures.length;
        gltf.textures.push({ source: imgIdx, sampler: 0 });
        return texIdx;
    }

    // Material
    const mat = { name: 'material', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 1, roughnessFactor: 1 } };
    const texDir = path.join(WORK_DIR, 'textures');
    if (textureFiles) {
        const albedo = textureFiles.AlbedoPBR;
        if (albedo) { const idx = addTexture(path.join(texDir, albedo.cleanFile || albedo.filename)); if (idx >= 0) mat.pbrMetallicRoughness.baseColorTexture = { index: idx }; }
        const metal = textureFiles.MetalnessPBR;
        if (metal) { const idx = addTexture(path.join(texDir, metal.cleanFile || metal.filename)); if (idx >= 0) mat.pbrMetallicRoughness.metallicRoughnessTexture = { index: idx }; }
        const norm = textureFiles.NormalMap;
        if (norm) { const idx = addTexture(path.join(texDir, norm.cleanFile || norm.filename)); if (idx >= 0) mat.normalTexture = { index: idx, scale: 1 }; }
        const emit = textureFiles.EmitColor;
        if (emit) { const idx = addTexture(path.join(texDir, emit.cleanFile || emit.filename)); if (idx >= 0) { mat.emissiveTexture = { index: idx }; mat.emissiveFactor = [1, 1, 1]; } }
    }
    gltf.materials.push(mat);

    for (const geom of geometries) {
        const prim = { attributes: {}, material: 0 };
        prim.indices = addAccessor(geom.indices, geom.indices.BYTES_PER_ELEMENT === 4 ? 5125 : 5123, geom.indices.length, 1);
        for (const [name, attr] of Object.entries(geom.attributes))
            prim.attributes[name] = addAccessor(attr.data, attr.componentType || 5126, attr.count, attr.itemSize, attr.normalized);
        gltf.meshes[0].primitives.push(prim);
    }

    const binBuffer = Buffer.concat(binChunks);
    gltf.buffers.push({ byteLength: binBuffer.length });

    // Write GLB
    const jsonStr = JSON.stringify(gltf);
    const jsonBuf = Buffer.from(jsonStr);
    const jsonPad = Buffer.alloc(Math.ceil(jsonBuf.length / 4) * 4, 0x20); jsonBuf.copy(jsonPad);
    const binPad = Buffer.alloc(Math.ceil(binBuffer.length / 4) * 4); binBuffer.copy(binPad);

    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546C67, 0); header.writeUInt32LE(2, 4);
    header.writeUInt32LE(12 + 8 + jsonPad.length + 8 + binPad.length, 8);
    const jch = Buffer.alloc(8); jch.writeUInt32LE(jsonPad.length, 0); jch.writeUInt32LE(0x4E4F534A, 4);
    const bch = Buffer.alloc(8); bch.writeUInt32LE(binPad.length, 0); bch.writeUInt32LE(0x004E4942, 4);

    return Buffer.concat([header, jch, jsonPad, bch, binPad]);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const arg = process.argv[2];
    if (!arg) {
        console.log('Usage: node download.js <sketchfab_url_or_uid> [output.glb]');
        console.log('Example: node download.js https://sketchfab.com/3d-models/retro-futuristic-car-1d98d7d5c12b4ad591c7efeeb35f6278');
        process.exit(1);
    }

    const uidMatch = arg.match(/([a-f0-9]{32})/);
    if (!uidMatch) { console.error('Could not extract model UID from:', arg); process.exit(1); }
    const uid = uidMatch[1];
    const outputPath = process.argv[3] || `${uid}.glb`;

    console.log(`Sketchfab Downloader — Model: ${uid}\n`);

    const config = await getModelConfig(uid);
    console.log(`  Base URL: ${config.baseUrl}`);
    console.log(`  Textures: ${Object.keys(config.textureMap).join(', ') || 'none'}\n`);

    await ensureWasm(config.html);
    config.staticKey = await extractStaticKey(config.html);

    await downloadFiles(config);
    await decryptAll(config);

    let textureFiles = config.textureMap;
    try { textureFiles = await descrambleTextures(config); } catch (e) { console.warn(`  Texture descramble failed: ${e.message}`); }

    const osgjsData = JSON.parse(fs.readFileSync(path.join(WORK_DIR, 'file.osgjs'), 'utf8'));
    const polyBin = fs.readFileSync(path.join(WORK_DIR, 'model_file.bin'));
    let wireBin = null;
    const wirePath = path.join(WORK_DIR, 'model_file_wireframe.bin');
    if (fs.existsSync(wirePath)) wireBin = fs.readFileSync(wirePath);

    const glb = convertToGltf(osgjsData, polyBin, wireBin, textureFiles);

    fs.writeFileSync(outputPath, glb);
    console.log(`\n[6/6] Done! ${outputPath} (${(glb.length / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
