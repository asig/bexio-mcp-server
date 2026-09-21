import { describe, it, expect } from "vitest";
import { parseBearerAuthorization } from "./bearer.js";

describe("parseBearerAuthorization", () => {
  it("extracts a Bearer token", () => {
    expect(parseBearerAuthorization("Bearer abc123")).toBe("abc123");
  });

  it("is case-insensitive on the scheme", () => {
    expect(parseBearerAuthorization("bearer tok")).toBe("tok");
    expect(parseBearerAuthorization("BEARER tok")).toBe("tok");
  });

  it("trims surrounding whitespace", () => {
    expect(parseBearerAuthorization("  Bearer   my-token  ")).toBe("my-token");
  });

  it("keeps JWT-style tokens intact", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig";
    expect(parseBearerAuthorization(`Bearer ${jwt}`)).toBe(jwt);
  });

  it("returns undefined when header is missing", () => {
    expect(parseBearerAuthorization(undefined)).toBeUndefined();
  });

  it("returns undefined for non-Bearer schemes", () => {
    expect(parseBearerAuthorization("Basic dXNlcjpwYXNz")).toBeUndefined();
    expect(parseBearerAuthorization("Token abc")).toBeUndefined();
  });

  it("returns undefined for empty Bearer value", () => {
    expect(parseBearerAuthorization("Bearer ")).toBeUndefined();
    expect(parseBearerAuthorization("Bearer   ")).toBeUndefined();
  });

  it("uses the first value when Authorization is an array", () => {
    expect(parseBearerAuthorization(["Bearer first", "Bearer second"])).toBe(
      "first"
    );
  });
});
