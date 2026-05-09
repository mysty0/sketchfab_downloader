# Sketchfab Downloader

Download 3D models from Sketchfab's embed viewer and convert them to glTF 2.0 (`.glb`).

Handles the full pipeline: encrypted `.binz` decryption, `osgjs` scene graph parsing, texture descrambling, and PBR material assembly.

## Usage

```bash
npm install
node download.js <sketchfab_url_or_uid> [output.glb]
```

```bash
# Full URL
node download.js https://sketchfab.com/3d-models/some-model-abc123def456

# Just the UID
node download.js abc123def456789abcdef0123456789a

# Custom output path
node download.js https://sketchfab.com/3d-models/some-model-abc123 my_model.glb
```

## Requirements

- Node.js 18+
- `sharp` (installed via npm, handles image decode/encode for texture descrambling)

## What it does

```
Sketchfab embed page
    │
    ├─ Extract model config (binz URLs, encryption keys, texture PKs)
    │
    ├─ Download encrypted .binz files
    │   ├─ file.binz          (scene graph)
    │   ├─ model_file.binz    (geometry)
    │   └─ model_file_wireframe.binz
    │
    ├─ Decrypt via WASM module
    │   ├─ XOR key derivation (static key + per-model diter.b)
    │   ├─ Web Worker protocol replication
    │   └─ Gunzip decompression
    │
    ├─ Download & descramble textures
    │   ├─ 8×8 block diagonal zigzag permutation
    │   ├─ Per-block rotation (4 orientations)
    │   └─ pk-seeded pixel offset
    │
    ├─ Decode osgjs geometry
    │   ├─ Varint + zigzag decoding
    │   ├─ Triangle strip → triangle list
    │   ├─ Parallelogram vertex prediction
    │   ├─ Spherical normal/tangent decode
    │   └─ Quantized vertex/UV dequantization
    │
    └─ Output .glb with PBR material
        ├─ Albedo, metalness, roughness textures
        ├─ Normal map, emissive map
        └─ Positions, normals, tangents, UVs, colors
```

## Individual scripts

| Script | Purpose |
|--------|---------|
| `download.js` | All-in-one: URL → `.glb` |
| `decrypt.js` | Decrypt `.binz` files only |
| `osgjs2gltf.js` | Convert decrypted osgjs → glTF |
| `descramble.py` | Descramble a single texture (Python) |

## Documentation

Full reverse engineering writeup in [`docs/sketchfab-binz-format.md`](docs/sketchfab-binz-format.md) covering:

- Embed page structure and model config extraction
- JS bundle identification and deobfuscation (webcrack, string array rotation)
- WASM decryption module (Rick Roll export names)
- Web Worker communication protocol
- osgjs binary format (varint, parallelogram prediction, spherical normals)
- GPU texture descramble shader (block zigzag + pk offset)
- UV coordinate conventions (OpenGL → glTF V-flip)

## Notes

- The `deobfuscated/decrypt.wasm` file (extracted from Sketchfab's viewer) is required for decryption. It's not included in this repo — extract it using the process documented in the docs.
- Texture descrambling requires `sharp`. Without it, the script falls back to using scrambled textures and prints a warning.
- Cached downloads are stored in `.cache/` and reused on subsequent runs for the same model.

## License

MIT
