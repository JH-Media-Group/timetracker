import { createMcpHttpServer } from "./http.js";

const port = Number(process.env.MCP_PORT ?? 3201);
const baseUrl = process.env.TALLY_API_BASE_URL;
if (!baseUrl) throw new Error("TALLY_API_BASE_URL is required");
const publicUrl = process.env.TALLY_PUBLIC_URL;
if (!publicUrl) throw new Error("TALLY_PUBLIC_URL is required");
const publicOrigin = new URL(publicUrl);
if (publicOrigin.username || publicOrigin.password || publicOrigin.search || publicOrigin.hash || publicOrigin.pathname !== "/" ||
    (process.env.NODE_ENV === "production" && publicOrigin.protocol !== "https:")) {
  throw new Error("TALLY_PUBLIC_URL must be the public HTTPS origin in production");
}
createMcpHttpServer({ baseUrl, publicUrl }).listen(port, () => {
  console.log(`Tally MCP listening on :${port}`);
});
