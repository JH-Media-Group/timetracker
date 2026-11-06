import { env } from "@/server/env";
import { TOKEN_SCOPES } from "@/lib/api-token-scopes";

export const oauthIssuer = () => env.APP_URL.replace(/\/$/, "");
export const mcpResource = () => `${oauthIssuer()}/mcp`;
export const protectedResourceMetadata = () => ({
  resource: mcpResource(), authorization_servers: [oauthIssuer()], scopes_supported: [...TOKEN_SCOPES],
});
export const authorizationServerMetadata = () => ({
  issuer: oauthIssuer(),
  authorization_endpoint: `${oauthIssuer()}/oauth/authorize`,
  token_endpoint: `${oauthIssuer()}/oauth/token`,
  registration_endpoint: `${oauthIssuer()}/oauth/register`,
  response_types_supported: ["code"], grant_types_supported: ["authorization_code"],
  code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
  authorization_response_iss_parameter_supported: true,
  scopes_supported: [...TOKEN_SCOPES],
});
