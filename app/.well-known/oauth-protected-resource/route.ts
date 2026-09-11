/**
 * OAuth protected-resource metadata (RFC 9728) for /mcp — spec 126 phase 2
 * stub. Phase 1 auth is bearer personal-access tokens only, so
 * `authorization_servers` is empty: a client that discovers this document
 * learns it must present a pre-issued Bearer token.
 *
 * Phase 2 (OAuth 2.1 authorization-code + PKCE for grok.com Connectors)
 * would: (1) stand up /oauth/authorize and /oauth/token (or point at an
 * external AS), (2) list it in `authorization_servers`, (3) validate the
 * resulting access tokens in lib/mcp/remote-auth.ts alongside rf_* tokens.
 * Do not build without an explicit go-ahead (spec 126 non-goal).
 */
import { getEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const base = getEnv().APP_URL ?? "https://app.recommendedfirst.com";
  return Response.json({
    resource: `${base.replace(/\/$/, "")}/mcp`,
    authorization_servers: [],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp:read"],
    resource_documentation: "https://recommendedfirst.com",
  });
}
