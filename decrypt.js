const fs = require('fs');
const path = require('path');

const STATIC_KEY = "77d92dd656ac3fdde472d5ba59747f42ac0ce217";

function parseWasmDataSize(wasmBytes) {
    let m = 65536;
    let d = 8;
    while (d < wasmBytes.length) {
        function v() { return wasmBytes[d++]; }
        function w() {
            let t = d, n = 0, e = 128;
            while (128 & e) { e = wasmBytes[d]; n |= (127 & e) << (7 * (d - t)); d++; }
            return n;
        }
        let y = w(), I = w(), h = d + I;
        if (y < 0 || y > 11 || I <= 0 || h > wasmBytes.length) break;
        if (6 === y) { w(); v(); v(); w(); let _ = w(); w(); m = _; }
        if (11 === y) { for (let Z = w(), A = 0; A !== Z && d < h; A++) { v(); w(); w(); w(); let U = w(); d += U; } }
        d = h;
    }
    return m;
}

async function initWasm(wasmBytes) {
    const r = new Uint8Array(wasmBytes);
    const m = parseWasmDataSize(r);
    const u = 536870912;
    const g = 262144 + ((m + 65535) >> 16 << 16);
    let currentBreak = m;

    const memory = new WebAssembly.Memory({ initial: g >> 16, maximum: u >> 16, shared: false });
    let uint8View = new Uint8Array(memory.buffer);
    let uint32View = new Uint32Array(memory.buffer);

    function refreshViews() {
        uint8View = new Uint8Array(memory.buffer);
        uint32View = new Uint32Array(memory.buffer);
    }

    const env = {
        sbrk(increment) {
            const old = currentBreak;
            const newBreak = old + increment;
            const overflow = newBreak - memory.buffer.byteLength;
            if (overflow > 0) { memory.grow((overflow + 65535) >> 16); refreshViews(); }
            currentBreak = newBreak;
            return old | 0;
        },
        time(t) { const r = Date.now() / 1000 | 0; if (t) uint32View[t >> 2] = r; return r; },
        gettimeofday(t) { const n = Date.now(); uint32View[t >> 2] = n / 1000 | 0; uint32View[(t + 4) >> 2] = n % 1000 * 1000 | 0; },
        abort() { throw new Error('WASM abort'); },
        memory
    };
    env.__lock = env.__unlock = env.setjmp = env.__cxa_atexit = function() {};

    const result = await WebAssembly.instantiate(r, { env });
    const ex = result.instance.exports;
    if (ex.__wasm_call_ctors) ex.__wasm_call_ctors();

    return { a: ex, H: () => { refreshViews(); return uint8View; }, memory };
}

async function decrypt(binzPath, diterB, diterV, outputPath) {
    const wasmBytes = fs.readFileSync(path.join(__dirname, 'deobfuscated', 'decrypt.wasm'));
    const encryptedData = fs.readFileSync(binzPath);

    console.log(`  Init WASM...`);
    const wasm = await initWasm(wasmBytes);

    // WASM exports mapped to Rick Roll names:
    // func 3: heSBnb29k... = allocate input buffer (i32) -> i32
    // func 4: mV2ZXIgZ2... = reset state () -> void
    // func 5: Umlja1Jvb... = RickRolled4U - key setup (i32, i32) -> i32
    // func 6: dmVyIGdvb... = allocate diterB buffer (i32) -> i32
    // func 7: GRlc2Vydm... = process/decrypt (i32) -> ... (called with 0 or 1)
    // func 9: FrZSB5b3U... = called as "advance" () -> void
    // func 10: bGwgYSBsa... = get output chunk info () -> i32
    // func 11: TmV2ZXIgZ... = get output start/alloc () -> i32

    const allocInput = wasm.a['heSBnb29kYnllCk5ldmVyIGdvbm5hIHRl'];    // func 3
    const reset = wasm.a['mV2ZXIgZ29ubmEgbGV0IHlvdSBkb3duCk5l'];       // func 4
    const rickRolled = wasm.a['Umlja1JvbGxlZDRV'];                       // func 5
    const allocDiterB = wasm.a['dmVyIGdvbm5hIHJ1biBhcm91bmQgYW5kI'];    // func 6
    const process_ = wasm.a['GRlc2VydCB5b3UKTmV2ZXIgZ29ubmEgbW'];       // func 7
    const advance = wasm.a['FrZSB5b3UgY3J5Ck5ldmVyIGdvbm5hIHN'];        // func 9
    const getOutputInfo = wasm.a['bGwgYSBsaWUgYW5kIGh1cnQgeW91Cg'];      // func 10
    const getOutputStart = wasm.a['TmV2ZXIgZ29ubmEgZ2l2ZSB5b3UgdXAKT'];  // func 11

    // Step 1: Set up key via RickRolled4U
    const keyHex = STATIC_KEY.slice(0, 40).toLowerCase();
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
    const keyArray = new Array(10);
    for (let t = 0; t < 10; t++) keyArray[t] = collected[2 * t] ^ xorAll;

    const keyOffset = rickRolled(seed, 40);
    let mem = wasm.H();
    for (let t = 0; t < 10; t++) {
        let hex = keyArray[t].toString(16);
        hex = "0".repeat(4 - hex.length) + hex;
        for (let n = 0; n < hex.length; n++) {
            mem[keyOffset + n + 4 * t] = hex.charCodeAt(n);
        }
    }
    console.log(`  Key set (seed=${seed})`);

    // Step 2: Reset + load diterB
    // Worker sequence:
    //   reset()
    //   diterBOffset = allocDiterB(diterBBytes.length)  // func 6
    //   copy diterB bytes to memory
    //   process_(0)  // initial call with 0
    //   for each 10240-byte chunk:
    //     chunkOffset = allocInput(chunkSize)  // func 3
    //     copy chunk
    //     hasMore = process_(1)  // func 7 called with 1
    //     while hasMore:
    //       output = memory.subarray(getOutputStart(), getOutputStart() + getOutputInfo())
    //       advance()
    //       hasMore = process_(0)

    const diterBClean = diterB.replace(/\\n/g, '').replace(/\n/g, '');
    const diterBBytes = Buffer.from(diterBClean, 'base64');

    reset();

    const diterBOffset = allocDiterB(diterBBytes.length);
    mem = wasm.H();
    for (let i = 0; i < diterBBytes.length; i++) {
        mem[diterBOffset + i] = diterBBytes[i];
    }
    console.log(`  DiterB loaded (${diterBBytes.length} bytes)`);

    // Initial process call with 0
    process_(0);

    // Step 3: Process encrypted data in 10240-byte chunks
    const inputData = new Uint8Array(encryptedData);
    const outputChunks = [];
    const CHUNK_SIZE = 10240;

    for (let offset = 0; offset < inputData.length; offset += CHUNK_SIZE) {
        const chunkLen = Math.min(CHUNK_SIZE, inputData.length - offset);
        const chunkOffset = allocInput(chunkLen);
        mem = wasm.H();
        for (let i = 0; i < chunkLen; i++) {
            mem[chunkOffset + i] = inputData[offset + i];
        }

        let hasMore = process_(1);
        while (hasMore) {
            mem = wasm.H();
            const outStart = getOutputStart();
            const outEnd = getOutputStart() + getOutputInfo();
            const chunk = mem.subarray(outStart, outEnd).slice(0);
            outputChunks.push(Buffer.from(chunk));
            advance();
            hasMore = process_(0);
        }
    }

    if (outputChunks.length === 0) {
        throw new Error('No output produced');
    }

    const result = Buffer.concat(outputChunks);
    console.log(`  Decrypted: ${result.length} bytes`);

    let finalData = result;
    if (result[0] === 0x1f && result[1] === 0x8b) {
        const zlib = require('zlib');
        finalData = zlib.gunzipSync(result);
        console.log(`  Decompressed: ${finalData.length} bytes`);
    }

    fs.writeFileSync(outputPath, finalData);
    console.log(`  Saved: ${outputPath}`);

    try {
        const json = JSON.parse(finalData.toString('utf8'));
        console.log(`  Valid osgjs! Version: ${json.Version || '?'}`);
        return json;
    } catch (e) {
        console.log(`  Header: ${finalData.slice(0, 16).toString('hex')}`);
    }
}

async function getModelConfig(modelUid) {
    const https = require('https');
    return new Promise((resolve, reject) => {
        https.get(`https://sketchfab.com/models/${modelUid}/embed`, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                const decoded = data.replace(/&#34;/g, '"').replace(/&quot;/g, '"');
                const pMatch = decoded.match(/"p"\s*:\s*\[\{[^}]*"v"\s*:\s*(\d+)[^}]*"b"\s*:\s*"([^"]+)"/);
                const urlMatch = decoded.match(/https:\/\/media\.sketchfab\.com\/models\/[^"]*\/file\.binz/);
                if (!pMatch || !urlMatch) { reject(new Error('Config not found')); return; }
                resolve({ binzUrl: urlMatch[0], diterV: parseInt(pMatch[1]), diterB: pMatch[2] });
            });
        }).on('error', reject);
    });
}

async function downloadFile(url, destPath) {
    const https = require('https');
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        https.get(url, (res) => { res.pipe(file); file.on('finish', () => { file.close(); resolve(); }); }).on('error', reject);
    });
}

async function main() {
    const modelUid = process.argv[2] || '1d98d7d5c12b4ad591c7efeeb35f6278';
    console.log(`Model: ${modelUid}`);
    const config = await getModelConfig(modelUid);
    console.log(`Binz: ${config.binzUrl}`);
    console.log(`Key length: ${config.diterB.length}`);

    const binzPath = path.join(__dirname, 'model', 'file.binz');
    await downloadFile(config.binzUrl, binzPath);
    console.log(`Downloaded: ${fs.statSync(binzPath).size} bytes`);

    const outputPath = path.join(__dirname, 'model', 'file.osgjs');
    console.log(`\nDecrypting...`);
    await decrypt(binzPath, config.diterB, config.diterV, outputPath);
}

main().catch(err => { console.error('Error:', err); process.exit(1); });
