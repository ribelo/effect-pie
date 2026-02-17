# openWakeWord Bundled Bootstrap Assets

Runtime wakeword data now lives in XDG directories:

- Data: `$XDG_DATA_HOME/effect-pi/openwakeword` (fallback `~/.local/share/effect-pi/openwakeword`)
- Config: `$XDG_CONFIG_HOME/effect-pi/wakeword` (fallback `~/.config/effect-pi/wakeword`)

This repository directory is only a bundled bootstrap source for defaults.
Do not store personal training data or custom wakewords here.

Runtime pin:

- `onnxruntime-web@1.22.0`

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
