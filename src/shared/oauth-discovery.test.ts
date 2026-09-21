import { describe, it, expect } from "vitest";
import {
  DEFAULT_BEXIO_OAUTH_ISSUER,
  buildProtectedResourceMetadata,
  buildWwwAuthenticateHeader,
  buildBexioAuthorizationServerMetadata,
  loadOAuthDiscoveryConfig,
  protectedResourceMetadataUrl,
  resolvePublicBaseUrl,
} from "./oauth-discovery.js";

describe("loadOAuthDiscoveryConfig", () => {
  it("uses defaults when env is empty", () => {
    const c = loadOAuthDiscoveryConfig({});
    expect(c.issuer).toBe(DEFAULT_BEXIO_OAUTH_ISSUER);
    expect(c.scopes).toContain("openid");
    expect(c.scopes).toContain("contact_edit");
    expect(c.publicBaseUrl).toBeUndefined();
  });

  it("parses custom issuer, scopes, and public URL", () => {
    const c = loadOAuthDiscoveryConfig({
      BEXIO_OAUTH_ISSUER: "https://auth.example/realms/bexio/",
      BEXIO_OAUTH_SCOPES: "openid, contact_show kb_invoice_show",
      MCP_PUBLIC_URL: "https://mcp.example.com/",
    });
    expect(c.issuer).toBe("https://auth.example/realms/bexio");
    expect(c.scopes).toEqual(["openid", "contact_show", "kb_invoice_show"]);
    expect(c.publicBaseUrl).toBe("https://mcp.example.com");
  });
});

describe("resolvePublicBaseUrl", () => {
  it("prefers configured public URL", () => {
    expect(
      resolvePublicBaseUrl("https://mcp.example.com/", {
        headers: { host: "localhost:8000" },
      })
    ).toBe("https://mcp.example.com");
  });

  it("uses X-Forwarded headers when present", () => {
    expect(
      resolvePublicBaseUrl(undefined, {
        protocol: "http",
        headers: {
          "x-forwarded-proto": "https",
          "x-forwarded-host": "mcp.example.com",
        },
      })
    ).toBe("https://mcp.example.com");
  });
});

describe("buildProtectedResourceMetadata", () => {
  it("builds RFC 9728 document pointing at Bexio issuer", () => {
    const meta = buildProtectedResourceMetadata({
      publicBaseUrl: "https://mcp.example.com",
      issuer: DEFAULT_BEXIO_OAUTH_ISSUER,
      scopes: ["openid", "contact_show"],
    });
    expect(meta.resource).toBe("https://mcp.example.com/mcp");
    expect(meta.authorization_servers).toEqual([DEFAULT_BEXIO_OAUTH_ISSUER]);
    expect(meta.bearer_methods_supported).toEqual(["header"]);
    expect(meta.scopes_supported).toEqual(["openid", "contact_show"]);
  });
});

describe("WWW-Authenticate", () => {
  it("includes resource_metadata URL", () => {
    const h = buildWwwAuthenticateHeader("https://mcp.example.com", "/mcp");
    expect(h).toContain('Bearer realm="bexio-mcp"');
    expect(h).toContain(
      'resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"'
    );
  });

  it("builds path-aware PRM URL", () => {
    expect(protectedResourceMetadataUrl("https://x.com", "/mcp")).toBe(
      "https://x.com/.well-known/oauth-protected-resource/mcp"
    );
  });
});

describe("buildBexioAuthorizationServerMetadata", () => {
  it("exposes authorize and token endpoints under the issuer", () => {
    const m = buildBexioAuthorizationServerMetadata(DEFAULT_BEXIO_OAUTH_ISSUER);
    expect(m["issuer"]).toBe(DEFAULT_BEXIO_OAUTH_ISSUER);
    expect(m["authorization_endpoint"]).toBe(
      `${DEFAULT_BEXIO_OAUTH_ISSUER}/protocol/openid-connect/auth`
    );
    expect(m["token_endpoint"]).toBe(
      `${DEFAULT_BEXIO_OAUTH_ISSUER}/protocol/openid-connect/token`
    );
    expect(m["grant_types_supported"]).toContain("authorization_code");
  });
});
