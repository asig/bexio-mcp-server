/**
 * HTTP Transport for Bexio MCP Server.
 * Provides HTTP/REST access for n8n, LibreChat, Claude, and other remote clients.
 *
 * IMPORTANT: All logging uses logger (stderr), stdout reserved for nothing in HTTP mode.
 *
 * Authentication for Bexio API calls:
 * - Prefer the request's Authorization: Bearer <token> header when present.
 * - Otherwise fall back to the env-configured active company (BEXIO_API_TOKEN /
 *   BEXIO_API_TOKENS via companyManager).
 *
 * OAuth discovery (MCP resource server):
 * - GET /.well-known/oauth-protected-resource[/mcp] — RFC 9728 PRM → Bexio IdP
 * - GET /.well-known/oauth-authorization-server — Bexio AS metadata (RFC 8414)
 * - 401 + WWW-Authenticate with resource_metadata when Bearer is missing
 */

import Fastify, {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import cors from "@fastify/cors";
import { logger } from "../logger.js";
import { getAllToolDefinitions, createHandlerRegistry } from "../tools/index.js";
import { companyManager } from "../company-manager.js";
import { parseBearerAuthorization } from "../shared/bearer.js";
import {
  buildBexioAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
  buildWwwAuthenticateHeader,
  loadOAuthDiscoveryConfig,
  resolvePublicBaseUrl,
} from "../shared/oauth-discovery.js";
import type { BexioClient } from "../bexio-client.js";

export interface HttpServerOptions {
  host: string;
  port: number;
}

type HandlerRegistry = Map<
  string,
  (args: unknown, clientOverride?: BexioClient) => Promise<unknown>
>;

/**
 * Resolve the BexioClient for this request:
 * 1. Authorization: Bearer <token> on the incoming call → use that token
 * 2. Else env-configured active company
 */
function resolveClient(request: FastifyRequest): BexioClient | undefined {
  const bearer = parseBearerAuthorization(request.headers.authorization);
  if (bearer) {
    return companyManager.clientForToken(bearer);
  }
  if (companyManager.hasConfiguredCompanies()) {
    return companyManager.getActiveClient();
  }
  return undefined;
}

function publicBaseForRequest(request: FastifyRequest): string {
  const { publicBaseUrl } = loadOAuthDiscoveryConfig();
  return resolvePublicBaseUrl(publicBaseUrl, {
    protocol: request.protocol,
    hostname: request.hostname,
    headers: request.headers as Record<string, unknown>,
  });
}

/** Send 401 with MCP OAuth discovery challenge. */
function sendUnauthorized(
  request: FastifyRequest,
  reply: FastifyReply,
  message = "Authorization required. Obtain a Bexio access token via OAuth and send Authorization: Bearer <token>."
): void {
  const base = publicBaseForRequest(request);
  reply
    .header("WWW-Authenticate", buildWwwAuthenticateHeader(base, "/mcp"))
    .code(401)
    .send({
      error: "unauthorized",
      error_description: message,
      resource_metadata: `${base}/.well-known/oauth-protected-resource/mcp`,
    });
}

/**
 * Creates an HTTP server for the MCP server.
 * This enables n8n and other HTTP clients to interact with the Bexio API.
 */
export async function createHttpServer(
  options: HttpServerOptions
): Promise<FastifyInstance> {
  const { host, port } = options;

  const oauthCfg = loadOAuthDiscoveryConfig();
  logger.info(
    `OAuth discovery: issuer=${oauthCfg.issuer}, publicBaseUrl=${oauthCfg.publicBaseUrl ?? "(from request Host)"}`
  );

  // Handler registry can take an optional per-request client (Bearer override).
  const handlerRegistry = createHandlerRegistry();

  const app: FastifyInstance = Fastify({
    logger: false, // We use our own logger
  });

  // Register CORS for browser/n8n access
  await app.register(cors, {
    origin: true,
  });

  logger.info("HTTP server initializing...");

  // ---- OAuth discovery (RFC 9728 + RFC 8414) ----

  const prmHandler = async (request: FastifyRequest) => {
    const base = publicBaseForRequest(request);
    return buildProtectedResourceMetadata(
      {
        publicBaseUrl: base,
        issuer: oauthCfg.issuer,
        scopes: oauthCfg.scopes,
      },
      "/mcp"
    );
  };

  app.get("/.well-known/oauth-protected-resource", prmHandler);
  app.get("/.well-known/oauth-protected-resource/mcp", prmHandler);

  app.get("/.well-known/oauth-authorization-server", async () => {
    return buildBexioAuthorizationServerMetadata(oauthCfg.issuer);
  });

  // OIDC discovery alias (some clients probe openid-configuration on the resource host)
  app.get("/.well-known/openid-configuration", async () => {
    return buildBexioAuthorizationServerMetadata(oauthCfg.issuer);
  });

  // Health check endpoint
  app.get("/", async (request) => {
    const base = publicBaseForRequest(request);
    return {
      status: "running",
      server: "bexio-mcp-server",
      version: "2.5.0",
      mode: "http",
      auth: companyManager.hasConfiguredCompanies()
        ? "env-token-or-bearer"
        : "bearer-required",
      oauth: {
        issuer: oauthCfg.issuer,
        protected_resource_metadata: `${base}/.well-known/oauth-protected-resource/mcp`,
        authorization_server_metadata: `${base}/.well-known/oauth-authorization-server`,
      },
    };
  });

  // List tools endpoint (GET for simplicity) — public catalog
  app.get("/tools", async () => {
    const tools = getAllToolDefinitions();
    return { tools, count: tools.length };
  });

  // MCP-style JSON-RPC endpoint
  app.post<{
    Body:
      | {
          jsonrpc?: string;
          id?: string | number;
          method: string;
          params?: unknown;
        }
      | Array<{
          jsonrpc?: string;
          id?: string | number;
          method: string;
          params?: unknown;
        }>;
  }>("/mcp", async (request, reply) => {
    const body = request.body;
    const client = resolveClient(request);

    // Discovery-friendly challenge when no credentials (skip for initialize/tools/list)
    const needsAuth =
      !client &&
      !isPublicMcpMethod(body);

    if (needsAuth) {
      sendUnauthorized(request, reply);
      return;
    }

    // Handle batch requests
    if (Array.isArray(body)) {
      const results = await Promise.all(
        body.map((req) => handleJsonRpcRequest(req, handlerRegistry, client, request, reply))
      );
      return results;
    }

    // Handle single request
    return handleJsonRpcRequest(body, handlerRegistry, client, request, reply);
  });

  // Direct tool call endpoint (simpler than JSON-RPC)
  app.post<{
    Body: {
      name: string;
      arguments?: unknown;
    };
  }>("/tools/call", async (request, reply) => {
    const toolName = request.body?.name;
    try {
      const { name, arguments: args = {} } = request.body;

      if (!name) {
        return reply.code(400).send({ error: "Tool name is required" });
      }

      const handler = handlerRegistry.get(name);
      if (!handler) {
        return reply.code(404).send({ error: `Unknown tool: ${name}` });
      }

      const client = resolveClient(request);
      if (!client) {
        sendUnauthorized(request, reply);
        return;
      }

      const result = await handler(args, client);
      return {
        success: true,
        data: result,
        tool: name,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({
        success: false,
        error: errorMessage,
        tool: toolName || "unknown",
        timestamp: new Date().toISOString(),
      });
    }
  });

  // n8n-specific endpoint for easier integration
  app.post<{
    Body: {
      tool: string;
      params?: unknown;
    };
  }>("/n8n/call", async (request, reply) => {
    try {
      const { tool, params = {} } = request.body;

      if (!tool) {
        return reply.code(400).send({ error: "Tool name is required" });
      }

      const handler = handlerRegistry.get(tool);
      if (!handler) {
        return reply.code(404).send({ error: `Unknown tool: ${tool}` });
      }

      const client = resolveClient(request);
      if (!client) {
        sendUnauthorized(request, reply);
        return;
      }

      const result = await handler(params, client);
      return {
        success: true,
        data: result,
        tool,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({
        success: false,
        error: errorMessage,
        tool: request.body?.tool || "unknown",
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Start server
  try {
    await app.listen({ host, port });
    logger.info(`HTTP server listening on ${host}:${port}`);
    logger.info("Available endpoints:");
    logger.info("  GET  /                                          - Health check");
    logger.info("  GET  /.well-known/oauth-protected-resource[/mcp] - OAuth PRM (RFC 9728)");
    logger.info("  GET  /.well-known/oauth-authorization-server   - Bexio AS metadata");
    logger.info("  GET  /tools                                     - List all tools");
    logger.info("  POST /mcp                                       - JSON-RPC endpoint");
    logger.info("  POST /tools/call                                - Direct tool call");
    logger.info("  POST /n8n/call                                  - n8n-friendly endpoint");
    logger.info(
      "Auth: Authorization: Bearer <bexio-access-token> (OAuth via Bexio IdP); env token is optional fallback"
    );
  } catch (error) {
    logger.error("Failed to start HTTP server:", error);
    throw error;
  }

  return app;
}

/** Methods that do not require a Bexio token (handshake / catalog). */
function isPublicMcpMethod(
  body:
    | { method?: string }
    | Array<{ method?: string }>
    | undefined
): boolean {
  if (!body) return false;
  if (Array.isArray(body)) {
    return body.every(
      (r) => r.method === "initialize" || r.method === "tools/list" || r.method === "notifications/initialized"
    );
  }
  return (
    body.method === "initialize" ||
    body.method === "tools/list" ||
    body.method === "notifications/initialized"
  );
}

/**
 * Handle a JSON-RPC request.
 * @param clientOverride - BexioClient from request Bearer token, if any
 */
async function handleJsonRpcRequest(
  request: {
    jsonrpc?: string;
    id?: string | number;
    method: string;
    params?: unknown;
  },
  handlerRegistry: HandlerRegistry,
  clientOverride: BexioClient | undefined,
  httpRequest?: FastifyRequest,
  httpReply?: FastifyReply
): Promise<unknown> {
  const { id, method, params } = request;

  try {
    // Handle MCP protocol methods
    if (method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: {
            name: "bexio-mcp-server",
            version: "2.5.0",
          },
        },
      };
    }

    if (method === "notifications/initialized") {
      return { jsonrpc: "2.0", id, result: {} };
    }

    if (method === "tools/list") {
      const tools = getAllToolDefinitions();
      return {
        jsonrpc: "2.0",
        id,
        result: { tools },
      };
    }

    if (method === "tools/call") {
      const callParams = params as { name: string; arguments?: unknown } | undefined;
      if (!callParams?.name) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: "Invalid params: name is required" },
        };
      }

      const handler = handlerRegistry.get(callParams.name);
      if (!handler) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Unknown tool: ${callParams.name}` },
        };
      }

      if (!clientOverride && !companyManager.hasConfiguredCompanies()) {
        // Prefer HTTP 401 + WWW-Authenticate for OAuth-capable clients
        if (httpRequest && httpReply && !httpReply.sent) {
          sendUnauthorized(httpRequest, httpReply);
          return;
        }
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32001,
            message:
              "Missing Bexio access token. Authorize via Bexio OAuth, then send Authorization: Bearer <token>.",
          },
        };
      }

      const result = await handler(callParams.arguments ?? {}, clientOverride);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        },
      };
    }

    // Unknown method
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: errorMessage },
    };
  }
}
