import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resolveConfig, parseFileConfig, ConfigError } from "../src/config.js";

const FULL_ENV = { CODEX2KIMI_API_KEY: "sk-test" };

test("applies defaults when only api key provided", () => {
  const cfg = resolveConfig({}, FULL_ENV);
  expect(cfg.host).toBe("127.0.0.1");
  expect(cfg.port).toBe(8787);
  expect(cfg.anthropicBaseUrl).toBe("https://api.kimi.com/coding/");
  expect(cfg.maxTokensDefault).toBe(8192);
  expect(cfg.userAgent).toBe("claude-cli/2.1.150 (external, cli)");
  expect(cfg.logLevel).toBe("info");
  expect(cfg.anthropicApiKey).toBe("sk-test");
});

test("env overrides file values", () => {
  const file = { port: 9000, model: "from-file" };
  const env = { CODEX2KIMI_API_KEY: "sk-test", CODEX2KIMI_PORT: "9999" };
  const cfg = resolveConfig(file, env);
  expect(cfg.port).toBe(9999);
  expect(cfg.model).toBe("from-file");
});

test("throws ConfigError when api key missing", () => {
  expect(() => resolveConfig({}, {})).toThrow(ConfigError);
});

test("throws ConfigError on invalid port", () => {
  expect(() => resolveConfig({}, { CODEX2KIMI_API_KEY: "sk-test", CODEX2KIMI_PORT: "abc" })).toThrow(
    ConfigError,
  );
  expect(() => resolveConfig({ port: 70000 }, { CODEX2KIMI_API_KEY: "sk-test" })).toThrow(ConfigError);
});

test("rejects non-loopback host to avoid public exposure", () => {
  const cfg = resolveConfig({ host: "0.0.0.0" }, FULL_ENV);
  expect(cfg.host).toBe("127.0.0.1");
});

test("parseFileConfig parses valid JSON", () => {
  expect(parseFileConfig('{"port":9000}')).toEqual({ port: 9000 });
});

test("parseFileConfig throws ConfigError on malformed JSON", () => {
  expect(() => parseFileConfig("{not json")).toThrow(ConfigError);
});
