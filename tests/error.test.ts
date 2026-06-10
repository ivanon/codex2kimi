import { expect, test } from "vitest";
import { translateError, badRequest } from "../src/translate/error.js";

test("maps authentication_error to 401", () => {
  const { status, body } = translateError(
    { type: "error", error: { type: "authentication_error", message: "bad key" } },
    401,
  );
  expect(status).toBe(401);
  expect(body.error.type).toBe("authentication_error");
  expect(body.error.message).toBe("bad key");
});

test("maps rate_limit_error to 429", () => {
  expect(
    translateError({ type: "error", error: { type: "rate_limit_error", message: "slow" } }, 429).status,
  ).toBe(429);
});

test("maps overloaded_error to api_error type", () => {
  const { body } = translateError(
    { type: "error", error: { type: "overloaded_error", message: "busy" } },
    529,
  );
  expect(body.error.type).toBe("api_error");
});

test("falls back to api_error for unparseable body", () => {
  const { status, body } = translateError("<<html error>>", 502);
  expect(status).toBe(502);
  expect(body.error.type).toBe("api_error");
});

test("badRequest produces 400 invalid_request_error", () => {
  const { status, body } = badRequest("missing input");
  expect(status).toBe(400);
  expect(body.error.type).toBe("invalid_request_error");
  expect(body.error.message).toBe("missing input");
});
