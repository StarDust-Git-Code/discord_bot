const geminiBot = require("./gemini-bot.js");
const { startMcpServer } = require("./mcp-server.js");

console.error("Starting Discord MCP + Gemini Bot...");

startMcpServer();
geminiBot.start().catch((err) => console.error("Gemini bot failed:", err.message));

function shutdown() {
  console.error("Shutting down...");
  geminiBot.shutdown();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("unhandledRejection", (reason) => console.error("Unhandled rejection:", reason));
