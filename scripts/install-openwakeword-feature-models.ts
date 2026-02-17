import { createHash } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { EFFECT_PI_OPENWAKEWORD_DATA_DIR } from "../src/paths.ts";

type InstallConfig = {
  readonly outputDir: string;
  readonly melspectrogramUrl: string;
  readonly embeddingUrl: string;
  readonly melspectrogramSha256: string;
  readonly embeddingSha256: string;
};

const defaultOutputDir = path.resolve(EFFECT_PI_OPENWAKEWORD_DATA_DIR);

const defaultMelspectrogramUrl =
  "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/melspectrogram.onnx";
const defaultEmbeddingUrl =
  "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/embedding_model.onnx";

const usage = (): string => `Install real openWakeWord feature models with checksum validation.

Usage:
  bun run scripts/install-openwakeword-feature-models.ts \\
    --melspectrogram-sha256 <sha256> \\
    --embedding-sha256 <sha256> \\
    [--output-dir $XDG_DATA_HOME/effect-pi/openwakeword] \\
    [--melspectrogram-url <url>] \\
    [--embedding-url <url>]

Notes:
  - Checksums are mandatory. Do not install without verification.
  - Recommended source URLs are preconfigured for openWakeWord upstream.
`;

const parseArgs = (argv: ReadonlyArray<string>): InstallConfig => {
  const help = argv.includes("--help") || argv.includes("-h");
  if (help) {
    console.log(usage());
    process.exit(0);
  }

  const args = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      continue;
    }

    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }

    args.set(arg, value);
    index += 1;
  }

  const melspectrogramSha256 = args.get("--melspectrogram-sha256")?.trim().toLowerCase();
  const embeddingSha256 = args.get("--embedding-sha256")?.trim().toLowerCase();

  if (!melspectrogramSha256 || !embeddingSha256) {
    throw new Error(
      "Both --melspectrogram-sha256 and --embedding-sha256 are required.\n\n" + usage(),
    );
  }

  const sha256Pattern = /^[a-f0-9]{64}$/;
  if (!sha256Pattern.test(melspectrogramSha256)) {
    throw new Error("--melspectrogram-sha256 must be a 64-char lowercase hex string");
  }
  if (!sha256Pattern.test(embeddingSha256)) {
    throw new Error("--embedding-sha256 must be a 64-char lowercase hex string");
  }

  return {
    outputDir: path.resolve(args.get("--output-dir") ?? defaultOutputDir),
    melspectrogramUrl: args.get("--melspectrogram-url") ?? defaultMelspectrogramUrl,
    embeddingUrl: args.get("--embedding-url") ?? defaultEmbeddingUrl,
    melspectrogramSha256,
    embeddingSha256,
  };
};

const sha256 = (input: Uint8Array): string =>
  createHash("sha256").update(input).digest("hex").toLowerCase();

const download = async (url: string): Promise<Uint8Array> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url} (HTTP ${response.status})`);
  }

  return new Uint8Array(await response.arrayBuffer());
};

const writeAtomically = async (targetPath: string, data: Uint8Array): Promise<void> => {
  const dir = path.dirname(targetPath);
  const tmpPath = `${targetPath}.tmp`;

  await mkdir(dir, { recursive: true });
  await writeFile(tmpPath, data);

  try {
    await rename(tmpPath, targetPath);
  } catch (error) {
    await rm(tmpPath, { force: true });
    throw error;
  }
};

const assertRealModelSize = (fileName: string, data: Uint8Array): void => {
  if (data.length < 4_096) {
    throw new Error(
      `${fileName} is unexpectedly small (${data.length} bytes). Refusing to install possibly invalid model.`,
    );
  }
};

const install = async (config: InstallConfig): Promise<void> => {
  console.log(`Installing openWakeWord feature models into ${config.outputDir}`);

  const [melspectrogram, embedding] = await Promise.all([
    download(config.melspectrogramUrl),
    download(config.embeddingUrl),
  ]);

  assertRealModelSize("melspectrogram.onnx", melspectrogram);
  assertRealModelSize("embedding_model.onnx", embedding);

  const melHash = sha256(melspectrogram);
  const embeddingHash = sha256(embedding);

  if (melHash !== config.melspectrogramSha256) {
    throw new Error(
      `Checksum mismatch for melspectrogram.onnx. Expected ${config.melspectrogramSha256}, got ${melHash}`,
    );
  }

  if (embeddingHash !== config.embeddingSha256) {
    throw new Error(
      `Checksum mismatch for embedding_model.onnx. Expected ${config.embeddingSha256}, got ${embeddingHash}`,
    );
  }

  const melPath = path.join(config.outputDir, "melspectrogram.onnx");
  const embeddingPath = path.join(config.outputDir, "embedding_model.onnx");

  await writeAtomically(melPath, melspectrogram);
  await writeAtomically(embeddingPath, embedding);

  const [melStat, embeddingStat] = await Promise.all([stat(melPath), stat(embeddingPath)]);

  console.log("Installed models:");
  console.log(`- ${melPath} (${melStat.size} bytes)`);
  console.log(`- ${embeddingPath} (${embeddingStat.size} bytes)`);
  console.log("Checksums verified successfully.");
};

const main = async (): Promise<void> => {
  try {
    const config = parseArgs(Bun.argv.slice(2));
    await install(config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`openWakeWord model install failed: ${message}`);
    process.exit(1);
  }
};

await main();
