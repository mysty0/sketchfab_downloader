const fs = require('fs');
const path = require('path');

// --- Sketchfab binary decoders (extracted from viewer JS) ---

function decodeVarint(bytes, count, typeName) {
    const signed = typeName[0] !== 'U';
    const result = signed ? new Int32Array(count) : new Uint32Array(count);
    let a = 0, o = 0;
    while (a < count) {
        let s = 0, l = 0;
        do { s |= (bytes[o] & 127) << l; l += 7; } while ((bytes[o++] & 128) !== 0);
        result[a++] = s;
    }
    if (signed) {
        for (let u = 0; u < count; u++) {
            const c = result[u];
            result[u] = (c >> 1) ^ -(c & 1); // zigzag decode
        }
    }
    return result;
}

function deltaDecodeInPlace(arr, startIdx) {
    const start = startIdx || 0;
    let prev = arr[start];
    for (let i = start + 1; i < arr.length; i++) {
        const v = arr[i];
        prev = arr[i] = prev + (v >> 1 ^ -(v & 1));
    }
    return arr;
}

function dequantize(encoded, output, bbl, h, itemSize) {
    const count = encoded.length / itemSize;
    for (let i = 0; i < count; i++) {
        const base = i * itemSize;
        for (let j = 0; j < itemSize; j++) {
            output[base + j] = bbl[j] + encoded[base + j] * h[j];
        }
    }
    return output;
}

function decodeNormals(encoded, output, itemSize, epsilon, nphi, hasThirdComponent) {
    epsilon = epsilon || 0.25;
    nphi = nphi || 720;
    const PI = 3.14159265359;
    const cosEps = Math.cos(0.01745329251 * epsilon);
    const dPhi = PI / (nphi - 1);
    const dGamma = 1.57079632679 / (nphi - 1);
    const stride = hasThirdComponent ? 3 : 2;
    const count = encoded.length / stride;

    for (let i = 0; i < count; i++) {
        const outIdx = i * itemSize;
        const inIdx = i * stride;
        let S = encoded[inIdx];
        let x = encoded[inIdx + 1];

        if (itemSize === 4 && !hasThirdComponent) {
            output[outIdx + 3] = (S & 1024) ? -1 : 1;
            S &= ~1024;
        }

        const A0 = S * dPhi;
        const R = Math.cos(A0);
        const w = Math.sin(A0);
        const A1 = A0 + dGamma;
        let E = (cosEps - R * Math.cos(A1)) / Math.max(1e-5, w * Math.sin(A1));
        if (E > 1) E = 1; else if (E < -1) E = -1;
        const P = 6.28318530718 * x / Math.ceil(PI / Math.max(1e-5, Math.acos(E)));

        output[outIdx] = w * Math.cos(P);
        output[outIdx + 1] = w * Math.sin(P);
        output[outIdx + 2] = R;
    }
    return output;
}

function implicitDecode(encoded, output, startIdx, useExpected) {
    let r = encoded[2]; // expectedIndex
    const maskLen = encoded[1];
    const headerLen = 3;
    const maskView = encoded.subarray(headerLen, maskLen + headerLen);
    const masks = new Uint32Array(maskView.buffer, maskView.byteOffset, maskLen);
    let idx = startIdx;
    const padBits = maskLen * 32 - output.length;

    for (let u = 0; u < maskLen; u++) {
        const c = masks[u];
        let h = u * 32; // output position (independent of d)
        const dStart = (u === maskLen - 1) ? padBits : 0;
        for (let d = dStart; d < 32; d++, h++) {
            if (h >= output.length) break;
            if (c & ((-2147483648) >>> d)) {
                output[h] = encoded[idx++];
            } else {
                output[h] = useExpected ? r : r++;
            }
        }
    }
    return output;
}

function expectedRenumber(arr, state) {
    let n = state[0];
    for (let a = 0; a < arr.length; a++) {
        const o = n - arr[a];
        arr[a] = o;
        if (n <= o) n = o + 1;
    }
    state[0] = n;
    return arr;
}

// Index buffers narrower than 32-bit must be widened before delta/watermark
// decode, otherwise the arithmetic wraps (e.g. a Uint8 index buffer).
function widenIndices(arr) {
    if (arr instanceof Uint32Array || arr instanceof Int32Array) return arr;
    return Int32Array.from(arr);
}

function triStripToTriangles(indices) {
    if (indices.length < 3) return new Uint32Array(0);
    const tris = [];
    for (let i = 0; i < indices.length - 2; i++) {
        const a = indices[i], b = indices[i + 1], c = indices[i + 2];
        if (a === b || b === c || a === c) continue; // degenerate
        if (i % 2 === 0) {
            tris.push(a, b, c);
        } else {
            tris.push(b, a, c); // flip winding on odd
        }
    }
    return new Uint32Array(tris);
}

// Loose triangle list (already in triangle order): drop degenerate triangles
function looseTrianglesToTriangles(indices) {
    const tris = [];
    for (let i = 0; i + 2 < indices.length; i += 3) {
        const a = indices[i], b = indices[i + 1], c = indices[i + 2];
        if (a === b || b === c || a === c) continue; // degenerate
        tris.push(a, b, c);
    }
    return new Uint32Array(tris);
}

// Parallelogram predictor: reconstructs vertex positions from residuals + strip topology
function parallelogramPredict(data, itemSize, stripIndices) {
    const vertCount = data.length / itemSize;
    const visited = new Uint8Array(vertCount);
    const numStrip = stripIndices.length - 1;

    visited[stripIndices[0]] = 1;
    visited[stripIndices[1]] = 1;
    visited[stripIndices[2]] = 1;

    for (let i = 2; i < numStrip; i++) {
        const a = stripIndices[i - 2];
        const b = stripIndices[i - 1];
        const c = stripIndices[i];
        const d = stripIndices[i + 1];

        if (visited[d] !== 1) {
            visited[d] = 1;
            const ai = a * itemSize;
            const bi = b * itemSize;
            const ci = c * itemSize;
            const di = d * itemSize;
            for (let j = 0; j < itemSize; j++) {
                // parallelogram: d = d_residual + b + c - a
                data[di + j] = data[di + j] + data[bi + j] + data[ci + j] - data[ai + j];
            }
        }
    }
    return data;
}

// --- osgjs parser ---

function readBufferArray(binData, vb, typeName) {
    const offset = vb.Offset || 0;
    const size = vb.Size;
    const itemSize = vb.ItemSize || 1;

    if (vb.Encoding === 'varint') {
        return decodeVarint(new Uint8Array(binData, offset), size * itemSize, typeName);
    }

    const types = {
        Float32Array: Float32Array, Int32Array: Int32Array,
        Uint32Array: Uint32Array, Uint16Array: Uint16Array,
        Uint8Array: Uint8Array, Int16Array: Int16Array
    };
    const TypedArr = types[typeName];
    if (!TypedArr) throw new Error(`Unknown type: ${typeName}`);
    return new TypedArr(binData, offset, size * itemSize);
}

function processGeometry(geom, polyBin, wireBin, sharedState) {
    const userData = sharedState || {};
    const result = { name: geom.Name || 'unnamed', attributes: {}, indices: null, mode: 'TRIANGLES', material: null };
    const meta = {};

    // Parse UserDataContainer
    const udc = geom.UserDataContainer;
    if (udc && udc.Values) {
        for (const v of udc.Values) {
            const val = v.Value;
            meta[v.Name] = isNaN(Number(val)) ? val : Number(val);
        }
    }

    // Process primitives
    const primList = geom.PrimitiveSetList || [];
    const DELTA = 1, EXPECTED = 2, IMPLICIT = 4, TRIANGLE_ATTR = 16;
    const triMode = meta.triangle_mode || 0;
    const hasTriAttr = (meta.attributes || 0) & TRIANGLE_ATTR;
    const triChunks = [];
    // The "expected"/high-watermark counter is shared across all of a geometry's
    // primitives and processed in list order: the strip advances it, then the
    // loose-triangle set continues from the same value. A fresh counter per
    // primitive corrupts the loose-triangle indices.
    const expState = [0];
    for (const prim of primList) {
        const drawType = Object.keys(prim)[0];
        const draw = prim[drawType];
        const idxInfo = draw.Indices;
        if (!idxInfo) continue;
        if (draw.Mode !== 'TRIANGLE_STRIP' && draw.Mode !== 'TRIANGLES') continue;

        const arrInfo = idxInfo.Array;
        const arrType = Object.keys(arrInfo)[0];
        const arrDef = arrInfo[arrType];
        const isWireframe = arrDef.File && arrDef.File.includes('wireframe');
        const binSrc = isWireframe ? wireBin : polyBin;
        if (!binSrc) continue;

        const isStrip = draw.Mode === 'TRIANGLE_STRIP';
        let indices = widenIndices(readBufferArray(binSrc.buffer, { ...arrDef, ItemSize: 1 }, arrType));

        if (!hasTriAttr) {
            // Indices stored directly (not delta/watermark encoded).
            if (isStrip) { result.stripIndices = indices; triChunks.push(triStripToTriangles(indices)); }
            else triChunks.push(looseTrianglesToTriangles(indices));
            continue;
        }

        let out = indices, startIdx = 0;
        if ((triMode & IMPLICIT) && isStrip) {
            startIdx = 3 + indices[1]; // IMPLICIT_HEADER_LENGTH + mask_length
            out = new Int32Array(indices[0]);
        }
        if (triMode & DELTA) deltaDecodeInPlace(indices, startIdx);
        if ((triMode & IMPLICIT) && isStrip) implicitDecode(indices, out, startIdx, !!(triMode & EXPECTED));
        if (triMode & EXPECTED) expectedRenumber(out, expState);

        if (isStrip) {
            result.stripIndices = out; // kept for parallelogram vertex prediction
            triChunks.push(triStripToTriangles(out));
        } else {
            triChunks.push(looseTrianglesToTriangles(out));
        }
    }

    let total = 0;
    for (const c of triChunks) total += c.length;
    if (total) {
        const merged = new Uint32Array(total);
        let o = 0;
        for (const c of triChunks) { merged.set(c, o); o += c.length; }
        result.indices = merged;
        result.mode = 'TRIANGLES';
    }

    // Process vertex attributes
    if (!result.indices) return result;
    const vaList = geom.VertexAttributeList || {};
    for (const [attrName, attrDef] of Object.entries(vaList)) {
        const arrInfo = attrDef.Array;
        const arrType = Object.keys(arrInfo)[0];
        const arrDef = arrInfo[arrType];
        const isWireframe = arrDef.File && arrDef.File.includes('wireframe');
        const binSrc = isWireframe ? wireBin : polyBin;
        if (!binSrc) continue;

        const itemSize = attrDef.ItemSize || 1;
        let data = readBufferArray(binSrc.buffer, { ...arrDef, ItemSize: itemSize }, arrType);
        const count = arrDef.Size;
        const attrFlags = meta.attributes || 0;

        if (attrName === 'Vertex') {
            const vtxMode = meta.vertex_mode || 0;
            // Apply parallelogram prediction if flag set and strip indices available
            if ((vtxMode & 2) && result.stripIndices) {
                parallelogramPredict(data, itemSize, result.stripIndices);
            }
            // Dequantize if quantized
            if ((attrFlags & 1) || (vtxMode & 1)) {
                const prefix = 'vtx_';
                if (meta[prefix + 'bbl_x'] !== undefined) {
                    const bbl = [meta[prefix + 'bbl_x'], meta[prefix + 'bbl_y']];
                    const h = [meta[prefix + 'h_x'], meta[prefix + 'h_y']];
                    if (itemSize === 3) {
                        bbl.push(meta[prefix + 'bbl_z']);
                        h.push(meta[prefix + 'h_z']);
                    }
                    const floats = new Float32Array(data.length);
                    dequantize(data, floats, bbl, h, itemSize);
                    data = floats;
                }
            }
            result.attributes.POSITION = { data, itemSize, count };
        } else if (attrName === 'Normal') {
            if (attrFlags & 2) {
                const floats = new Float32Array(count * 3);
                decodeNormals(data, floats, 3, meta.epsilon, meta.nphi);
                result.attributes.NORMAL = { data: floats, itemSize: 3, count };
            } else {
                result.attributes.NORMAL = { data, itemSize, count };
            }
        } else if (attrName === 'Tangent') {
            if (attrFlags & 32) {
                const floats = new Float32Array(count * 4);
                decodeNormals(data, floats, 4, meta.epsilon, meta.nphi);
                result.attributes.TANGENT = { data: floats, itemSize: 4, count };
            }
        } else if (attrName.startsWith('TexCoord')) {
            const uvSuffix = attrName.replace('TexCoord', '');
            const prefix = `uv_${uvSuffix}_`;
            const uvMode = meta[`uv_${uvSuffix}_mode`] !== undefined ? meta[`uv_${uvSuffix}_mode`] : (meta.vertex_mode || 0);
            // Apply parallelogram prediction
            if ((uvMode & 2) && result.stripIndices) {
                parallelogramPredict(data, itemSize, result.stripIndices);
            }
            // Dequantize
            if (meta[prefix + 'bbl_x'] !== undefined && ((attrFlags & 4) || (uvMode & 1))) {
                const bbl = [meta[prefix + 'bbl_x'], meta[prefix + 'bbl_y']];
                const h = [meta[prefix + 'h_x'], meta[prefix + 'h_y']];
                const floats = new Float32Array(data.length);
                dequantize(data, floats, bbl, h, itemSize);
                data = floats;
            } else if (!(data instanceof Float32Array)) {
                data = new Float32Array(data);
            }
            // Flip V: osgjs V=0 at bottom (OpenGL), glTF V=0 at top
            for (let i = 1; i < data.length; i += (itemSize || 2)) {
                data[i] = 1.0 - data[i];
            }
            // Store with original osgjs name; will remap to continuous indices later
            result.attributes[`_TC_${uvSuffix}`] = { data, itemSize: itemSize || 2, count };
        } else if (attrName === 'Color') {
            if (data instanceof Uint8Array) {
                result.attributes.COLOR_0 = { data, itemSize: itemSize || 4, count, normalized: true, componentType: 5121 };
            } else {
                result.attributes.COLOR_0 = { data: new Float32Array(data), itemSize: itemSize || 4, count };
            }
        }
    }

    // Material
    const stateSet = geom.StateSet;
    if (stateSet && stateSet['osg.StateSet']) {
        const ss = stateSet['osg.StateSet'];
        const attrList = ss.AttributeList || [];
        for (const attr of attrList) {
            if (attr['osg.Material']) {
                result.material = attr['osg.Material'];
            }
        }
    }

    return result;
}

// --- glTF builder ---

function buildGLTF(geometries, textureMap, textureDir) {
    const gltf = {
        asset: { version: '2.0', generator: 'sketchfab-osgjs-converter' },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0, name: 'root' }],
        meshes: [{ primitives: [] }],
        accessors: [],
        bufferViews: [],
        buffers: [],
        materials: [],
        textures: [],
        images: [],
        samplers: []
    };

    const binChunks = [];
    let byteOffset = 0;

    function addAccessor(data, type, componentType, count, itemSize, normalized) {
        const typeMap = { 1: 'SCALAR', 2: 'VEC2', 3: 'VEC3', 4: 'VEC4' };
        let buf;
        if (componentType === 5126) buf = new Float32Array(data.buffer ? data : Array.from(data));
        else if (componentType === 5125) buf = new Uint32Array(data.buffer ? data : Array.from(data));
        else if (componentType === 5123) buf = new Uint16Array(data.buffer ? data : Array.from(data));
        else if (componentType === 5121) buf = new Uint8Array(data.buffer ? data : Array.from(data));
        else buf = new Float32Array(data);

        const bytes = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
        const padded = Buffer.alloc(Math.ceil(bytes.length / 4) * 4);
        bytes.copy(padded);

        const bvIdx = gltf.bufferViews.length;
        gltf.bufferViews.push({
            buffer: 0, byteOffset, byteLength: bytes.length,
            ...(type !== 'SCALAR' && componentType !== 5125 ? { byteStride: itemSize * buf.BYTES_PER_ELEMENT } : {})
        });

        const min = [], max = [];
        for (let j = 0; j < itemSize; j++) { min.push(Infinity); max.push(-Infinity); }
        for (let i = 0; i < count; i++) {
            for (let j = 0; j < itemSize; j++) {
                const v = buf[i * itemSize + j];
                if (v < min[j]) min[j] = v;
                if (v > max[j]) max[j] = v;
            }
        }

        const accIdx = gltf.accessors.length;
        gltf.accessors.push({
            bufferView: bvIdx, byteOffset: 0, componentType,
            count, type: typeMap[itemSize] || 'SCALAR',
            min, max,
            ...(normalized ? { normalized: true } : {})
        });

        binChunks.push(padded);
        byteOffset += padded.length;
        return accIdx;
    }

    // Add sampler
    gltf.samplers.push({ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 });

    // Add textures from textureMap
    function addImage(filename) {
        if (!filename) return -1;
        const filePath = path.join(textureDir, filename);
        if (!fs.existsSync(filePath)) return -1;

        const imgData = fs.readFileSync(filePath);
        const mimeType = filename.endsWith('.png') ? 'image/png' : 'image/jpeg';

        const padded = Buffer.alloc(Math.ceil(imgData.length / 4) * 4);
        imgData.copy(padded);

        const bvIdx = gltf.bufferViews.length;
        gltf.bufferViews.push({ buffer: 0, byteOffset, byteLength: imgData.length });
        byteOffset += padded.length;
        binChunks.push(padded);

        const imgIdx = gltf.images.length;
        gltf.images.push({ bufferView: bvIdx, mimeType });
        return imgIdx;
    }

    function addTexture(filename) {
        const imgIdx = addImage(filename);
        if (imgIdx < 0) return -1;
        const texIdx = gltf.textures.length;
        gltf.textures.push({ source: imgIdx, sampler: 0 });
        return texIdx;
    }

    // Build PBR material
    const material = {
        name: 'M_FordFalcon_RetroWave',
        pbrMetallicRoughness: {
            baseColorFactor: [1, 1, 1, 1],
            metallicFactor: 1,
            roughnessFactor: 1
        }
    };

    if (textureMap) {
        if (textureMap.albedo) {
            const idx = addTexture(textureMap.albedo);
            if (idx >= 0) material.pbrMetallicRoughness.baseColorTexture = { index: idx, texCoord: 0 };
        }
        if (textureMap.metalness) {
            const idx = addTexture(textureMap.metalness);
            if (idx >= 0) material.pbrMetallicRoughness.metallicRoughnessTexture = { index: idx, texCoord: 0 };
        }
        if (textureMap.normalMap) {
            const idx = addTexture(textureMap.normalMap);
            if (idx >= 0) material.normalTexture = { index: idx, texCoord: 0, scale: 1 };
        }
        if (textureMap.emissive) {
            const idx = addTexture(textureMap.emissive);
            if (idx >= 0) {
                material.emissiveTexture = { index: idx, texCoord: 0 };
                material.emissiveFactor = [1, 1, 1];
            }
        }
    }

    gltf.materials.push(material);

    for (const geom of geometries) {
        if (!geom.indices || !geom.attributes.POSITION) continue;

        const primitive = { attributes: {}, material: 0 };

        // Indices
        const idx = geom.indices;
        const idxType = idx.BYTES_PER_ELEMENT === 4 ? 5125 : 5123;
        primitive.indices = addAccessor(idx, 'SCALAR', idxType, idx.length, 1);

        // Attributes
        for (const [name, attr] of Object.entries(geom.attributes)) {
            const ct = attr.componentType || 5126;
            const norm = attr.normalized || false;
            primitive.attributes[name] = addAccessor(attr.data, name === 'SCALAR' ? 'SCALAR' : `VEC${attr.itemSize}`, ct, attr.count, attr.itemSize, norm);
        }

        // Remove byteStride from index bufferViews
        const idxBV = gltf.accessors[primitive.indices].bufferView;
        delete gltf.bufferViews[idxBV].byteStride;

        gltf.meshes[0].primitives.push(primitive);
    }

    const binBuffer = Buffer.concat(binChunks);
    gltf.buffers.push({ byteLength: binBuffer.length });

    return { json: gltf, bin: binBuffer };
}

// --- Recursive scene traversal ---

function buildUidMap(obj, map) {
    if (!obj || typeof obj !== 'object') return;
    if (obj.UniqueID !== undefined && Object.keys(obj).length > 1) {
        map[obj.UniqueID] = obj;
    }
    for (const v of Object.values(obj)) {
        if (Array.isArray(v)) v.forEach(c => buildUidMap(c, map));
        else if (typeof v === 'object') buildUidMap(v, map);
    }
}

function resolveRefs(obj, uidMap) {
    if (!obj || typeof obj !== 'object') return obj;
    if (obj.UniqueID !== undefined && Object.keys(obj).length === 1) {
        const resolved = uidMap[obj.UniqueID];
        if (resolved) return resolved;
    }
    for (const [k, v] of Object.entries(obj)) {
        if (Array.isArray(v)) {
            obj[k] = v.map(c => typeof c === 'object' ? resolveRefs(c, uidMap) : c);
        } else if (typeof v === 'object') {
            obj[k] = resolveRefs(v, uidMap);
        }
    }
    return obj;
}

function collectGeometries(node, polyBin, wireBin) {
    const uidMap = {};
    buildUidMap(node, uidMap);
    resolveRefs(node, uidMap);

    const results = [];
    const seen = new Set();
    const sharedState = { expectedState: [0] };

    function traverse(obj) {
        if (!obj || typeof obj !== 'object') return;

        if (obj['osg.Geometry']) {
            const geom = obj['osg.Geometry'];
            // Skip wireframe geometries (LINES mode, no Normal attribute)
            const prims = geom.PrimitiveSetList || [];
            const isWireframe = prims.some(p => {
                const dt = Object.values(p)[0];
                return dt && dt.Mode === 'LINES';
            });
            if (isWireframe) return;

            const uid = geom.UniqueID;
            if (uid !== undefined && seen.has(uid)) return;
            if (uid !== undefined) seen.add(uid);

            try {
                const result = processGeometry(geom, polyBin, wireBin, sharedState);
                if (result.indices && result.attributes.POSITION) {
                    // Remap _TC_* to continuous TEXCOORD_0, TEXCOORD_1, ...
                    const tcKeys = Object.keys(result.attributes).filter(k => k.startsWith('_TC_')).sort();
                    let tcIdx = 0;
                    for (const k of tcKeys) {
                        result.attributes[`TEXCOORD_${tcIdx++}`] = result.attributes[k];
                        delete result.attributes[k];
                    }
                    results.push(result);
                }
            } catch (e) {
                console.warn(`  Warning: skipping ${geom.Name}: ${e.message}`);
            }
        }

        const children = (obj['osg.Node'] && obj['osg.Node'].Children)
            || (obj['osg.MatrixTransform'] && obj['osg.MatrixTransform'].Children)
            || obj.Children;
        if (children) {
            for (const child of children) traverse(child);
        }
    }

    traverse(node);
    return results;
}

// --- Main ---

async function main() {
    const modelDir = path.join(__dirname, 'model');

    console.log('Loading osgjs...');
    const osgjs = JSON.parse(fs.readFileSync(path.join(modelDir, 'file.osgjs'), 'utf8'));

    console.log('Loading binary data...');
    const polyBin = fs.readFileSync(path.join(modelDir, 'model_file.bin'));
    let wireBin = null;
    const wireframePath = path.join(modelDir, 'model_file_wireframe.bin');
    if (fs.existsSync(wireframePath)) wireBin = fs.readFileSync(wireframePath);

    console.log('Processing geometry...');
    const geometries = collectGeometries(osgjs, polyBin, wireBin);
    console.log(`  Found ${geometries.length} geometries`);
    for (const g of geometries) {
        const attrs = Object.keys(g.attributes).join(', ');
        const idxCount = g.indices ? g.indices.length : 0;
        console.log(`  - ${g.name}: ${attrs} (${idxCount} indices)`);
    }

    console.log('Building glTF...');
    const textureMap = {
        albedo: 'albedo_clean.jpeg',
        emissive: 'emissive_clean.jpeg',
        normalMap: 'normalmap_clean.jpeg',
        metalness: 'metalness_clean.png',
        roughness: 'roughness_clean.jpeg',
    };
    const textureDir = path.join(modelDir, 'textures');
    const { json, bin } = buildGLTF(geometries, textureMap, textureDir);

    // Write as separate .gltf + .bin
    const gltfPath = path.join(modelDir, 'scene.gltf');
    const binPath = path.join(modelDir, 'scene.bin');

    json.buffers[0].uri = 'scene.bin';
    fs.writeFileSync(gltfPath, JSON.stringify(json, null, 2));
    fs.writeFileSync(binPath, bin);
    console.log(`Saved: ${gltfPath} (${JSON.stringify(json).length} bytes)`);
    console.log(`Saved: ${binPath} (${bin.length} bytes)`);

    // Also write .glb (binary glTF)
    const glbPath = path.join(modelDir, 'scene.glb');
    const jsonBuf = Buffer.from(JSON.stringify(json));
    const jsonPadded = Buffer.alloc(Math.ceil(jsonBuf.length / 4) * 4, 0x20);
    jsonBuf.copy(jsonPadded);
    const binPadded = Buffer.alloc(Math.ceil(bin.length / 4) * 4);
    bin.copy(binPadded);

    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546C67, 0); // glTF magic
    header.writeUInt32LE(2, 4);           // version
    header.writeUInt32LE(12 + 8 + jsonPadded.length + 8 + binPadded.length, 8);

    const jsonChunkHeader = Buffer.alloc(8);
    jsonChunkHeader.writeUInt32LE(jsonPadded.length, 0);
    jsonChunkHeader.writeUInt32LE(0x4E4F534A, 4); // JSON

    const binChunkHeader = Buffer.alloc(8);
    binChunkHeader.writeUInt32LE(binPadded.length, 0);
    binChunkHeader.writeUInt32LE(0x004E4942, 4); // BIN

    // Remove uri from buffer for GLB
    delete json.buffers[0].uri;
    const jsonBuf2 = Buffer.from(JSON.stringify(json));
    const jsonPadded2 = Buffer.alloc(Math.ceil(jsonBuf2.length / 4) * 4, 0x20);
    jsonBuf2.copy(jsonPadded2);
    jsonChunkHeader.writeUInt32LE(jsonPadded2.length, 0);
    header.writeUInt32LE(12 + 8 + jsonPadded2.length + 8 + binPadded.length, 8);

    const glb = Buffer.concat([header, jsonChunkHeader, jsonPadded2, binChunkHeader, binPadded]);
    fs.writeFileSync(glbPath, glb);
    console.log(`Saved: ${glbPath} (${glb.length} bytes)`);
}

main().catch(e => { console.error(e); process.exit(1); });
