import { afterEach, expect, test, vi } from "vitest";
import { createLogger } from "../src/logger.js";

afterEach(() => vi.restoreAllMocks());

test("debug level emits debug/info/error", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const l = createLogger("debug");
  l.debug("d"); l.info("i"); l.error("e");
  expect(log).toHaveBeenCalledTimes(2); // debug + info
  expect(err).toHaveBeenCalledTimes(1); // error
});

test("info level suppresses debug", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const l = createLogger("info");
  l.debug("d");
  l.info("i");
  expect(log).toHaveBeenCalledTimes(1);
  expect(log.mock.calls[0]![0]).toContain('"msg":"i"');
});

test("error level suppresses debug and info", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const l = createLogger("error");
  l.debug("d"); l.info("i"); l.error("e");
  expect(log).not.toHaveBeenCalled();
  expect(err).toHaveBeenCalledTimes(1);
});

test("includes structured fields in output", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  createLogger("info").info("response", { status: "completed", model: "gpt-5-codex" });
  expect(log.mock.calls[0]![0]).toContain('"status":"completed"');
  expect(log.mock.calls[0]![0]).toContain('"model":"gpt-5-codex"');
});
