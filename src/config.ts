import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export class ConfigError extends Error {}

export interface Config {
  host: string;
  port: number;
  anthropicBaseUrl: string;
  anthropicApiKey: string;
  model: string;
  maxTokensDefault: number;
  userAgent: string;
  logLevel: "debug" | "info" | "error";
}

interface FileConfig {
  host?: string;
  port?: number;
  anthropicBaseUrl?: string;
  anthropicApiKey?: string;
  model?: string;
  maxTokensDefault?: number;
  userAgent?: string;
  logLevel?: Config["logLevel"];
}

const DEFAULTS = {
  host: "127.0.0.1",
  port: 8787,
  anthropicBaseUrl: "https://api.kimi.com/coding/",
  model: "claude-sonnet-4-5-20250929",
  maxTokensDefault: 8192,
  userAgent: "claude-cli/2.1.150 (external, cli)",
  logLevel: "info" as const,
};

const CONFIG_PATH = join(homedir(), ".config", "codex2kimi", "config.json");

export function resolveConfig(
  file: FileConfig,
  env: Record<string, string | undefined>,
): Config {
  const apiKey = env.CODEX2KIMI_API_KEY ?? env.ANTHROPIC_API_KEY ?? file.anthropicApiKey;
  if (!apiKey) {
    throw new ConfigError(
      "缺少 anthropicApiKey：在 ~/.config/codex2kimi/config.json 设置，或导出 CODEX2KIMI_API_KEY",
    );
  }
  const portRaw = env.CODEX2KIMI_PORT ?? file.port;
  const port = portRaw !== undefined ? Number(portRaw) : DEFAULTS.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`端口非法：${String(portRaw)}（应为 1–65535 的整数）`);
  }
  return {
    host: "127.0.0.1", // 仅绑回环；忽略任何非回环配置，避免公网暴露
    port,
    anthropicBaseUrl: env.CODEX2KIMI_BASE_URL ?? file.anthropicBaseUrl ?? DEFAULTS.anthropicBaseUrl,
    anthropicApiKey: apiKey,
    model: env.CODEX2KIMI_MODEL ?? file.model ?? DEFAULTS.model,
    maxTokensDefault: file.maxTokensDefault ?? DEFAULTS.maxTokensDefault,
    userAgent: file.userAgent ?? DEFAULTS.userAgent,
    logLevel: (env.CODEX2KIMI_LOG_LEVEL as Config["logLevel"]) ?? file.logLevel ?? DEFAULTS.logLevel,
  };
}

export function loadConfig(): Config {
  let file: FileConfig = {};
  try {
    file = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as FileConfig;
  } catch {
    file = {}; // 文件不存在则全靠环境变量/默认值
  }
  return resolveConfig(file, process.env);
}
