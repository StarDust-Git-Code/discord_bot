const express = require("express");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { createMcpExpressApp } = require("@modelcontextprotocol/sdk/server/express.js");
const { createServer } = require("@pasympa/discord-mcp/dist/server.js");

const PORT = process.env.MCP_PORT || 3000;

function startMcpServer() {
  const app = createMcpExpressApp();
  const pkg = require("@pasympa/discord-mcp/package.json");

  app.post("/mcp", async (req, res) => {
    const server = createServer(pkg.version);
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
    } catch (err) {
      console.error("MCP error:", err.message);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  app.listen(PORT, () => {
    console.error(`MCP HTTP server listening on port ${PORT}`);
    console.error(`MCP endpoint: http://localhost:${PORT}/mcp`);
  });

  return app;
}

module.exports = { startMcpServer };
