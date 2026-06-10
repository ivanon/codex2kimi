import { expect, test } from "vitest";
import { VERSION } from "../src/version.js";

test("toolchain wired: VERSION exported", () => {
  expect(VERSION).toBe("0.1.0");
});
