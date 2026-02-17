# openWakeWord Assets

This directory must contain real openWakeWord feature models.

Required files from `manifest.json`:

- `melspectrogram.onnx`
- `embedding_model.onnx`
- `wakewords/<name>.onnx` or `wakewords/<name>.json` for each configured wakeword model

Runtime pin:

- `onnxruntime-web@1.22.0`

## Important

- Placeholder feature files are not accepted anymore.
- Training and live detection now fail fast when feature models are placeholders/invalid.
- There is no TypeScript feature-extractor fallback in runtime paths.

## Install Real Feature Models

Use the installer with upstream checksums:

```bash
bun run wakeword:install-feature-models \
  --melspectrogram-sha256 <sha256> \
  --embedding-sha256 <sha256>
```

Optional URL overrides:

- `--melspectrogram-url <url>`
- `--embedding-url <url>`
- `--output-dir <path>`

Checksums are mandatory; installer refuses to write files when checksum validation fails.
