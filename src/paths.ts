import * as os from "node:os";
import * as path from "node:path";

const resolveXdgHome = (envKey: "XDG_DATA_HOME" | "XDG_CONFIG_HOME", fallback: string): string => {
  const value = process.env[envKey]?.trim();
  if (value && value.length > 0) {
    return path.resolve(value);
  }

  return path.join(os.homedir(), fallback);
};

export const XDG_DATA_HOME = resolveXdgHome("XDG_DATA_HOME", ".local/share");
export const XDG_CONFIG_HOME = resolveXdgHome("XDG_CONFIG_HOME", ".config");

export const EFFECT_PI_DATA_DIR = path.join(XDG_DATA_HOME, "effect-pi");
export const EFFECT_PI_CONFIG_DIR = path.join(XDG_CONFIG_HOME, "effect-pi");

export const EFFECT_PI_OPENWAKEWORD_DATA_DIR = path.join(EFFECT_PI_DATA_DIR, "openwakeword");
export const EFFECT_PI_WAKEWORD_CONFIG_DIR = path.join(EFFECT_PI_CONFIG_DIR, "wakeword");

export const BUNDLED_OPENWAKEWORD_ASSET_DIR = path.join(process.cwd(), "assets", "openwakeword");
