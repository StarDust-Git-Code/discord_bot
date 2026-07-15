const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { createServer: createDiscordMcpServer } = require("@pasympa/discord-mcp/dist/server.js");
const { start: startGeminiBot, shutdown: shutdownGeminiBot } = require("./gemini-bot.js");

const PORT = process.env.PORT || 3000;
const DISCORD_API = "https://discord.com/api/v10";

// ─── Discord REST helpers ────────────────────────────────────────────────

async function discordFetch(path, options = {}) {
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN not set");
  const res = await fetch(`${DISCORD_API}${path}`, {
    ...options,
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json", ...options.headers },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.message || JSON.stringify(body));
  return body;
}

async function parseCommand(command) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");
  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=" + key,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: command }] }],
        systemInstruction: { role: "user", parts: [{ text: `Parse as JSON only.
Actions: LIST_GUILDS, LIST_CHANNELS (guild_id), CREATE_CHANNEL (guild_id,name,type=0|2|4,topic?,parent_id?), EDIT_CHANNEL (channel_id,name?,topic?), DELETE_CHANNEL (channel_id), SEND_MESSAGE (channel_id,content)
Channel types: 0=text, 2=voice, 4=category
Response: { "action": "ACTION", "params": { ... } }` }] },
        generationConfig: { temperature: 0.1, maxOutputTokens: 500 },
      }),
    }
  );
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return JSON.parse(text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""));
}

async function executeAction(action, params) {
  switch (action) {
    case "LIST_GUILDS": {
      const g = await discordFetch("/users/@me/guilds");
      return { success: true, message: g.map((x) => `${x.name} (id: ${x.id})`).join("\n") };
    }
    case "LIST_CHANNELS": {
      const c = await discordFetch(`/guilds/${params.guild_id}/channels`);
      return { success: true, message: c.filter((x) => [0, 2, 4].includes(x.type)).map((x) => `#${x.name} (${["text","voice","category"][x.type]}, id: ${x.id})`).join("\n") || "No channels" };
    }
    case "CREATE_CHANNEL": {
      const b = { name: params.name, type: params.type ?? 0 };
      if (params.topic) b.topic = params.topic;
      if (params.parent_id) b.parent_id = params.parent_id;
      const ch = await discordFetch(`/guilds/${params.guild_id}/channels`, { method: "POST", body: JSON.stringify(b) });
      return { success: true, message: `Created ${["text","voice","category"][ch.type] || "channel"} #${ch.name}` };
    }
    case "EDIT_CHANNEL": {
      const b = {};
      if (params.name) b.name = params.name;
      if (params.topic !== undefined) b.topic = params.topic;
      await discordFetch(`/channels/${params.channel_id}`, { method: "PATCH", body: JSON.stringify(b) });
      return { success: true, message: "Channel updated" };
    }
    case "DELETE_CHANNEL":
      await discordFetch(`/channels/${params.channel_id}`, { method: "DELETE" });
      return { success: true, message: "Channel deleted" };
    case "SEND_MESSAGE":
      await discordFetch(`/channels/${params.channel_id}/messages`, { method: "POST", body: JSON.stringify({ content: params.content }) });
      return { success: true, message: "Message sent" };
    default:
      return { success: false, message: "Unknown action" };
  }
}

// ─── Express app ─────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// MCP endpoint (standalone, no createMcpExpressApp)
const mcpPkg = require("@pasympa/discord-mcp/package.json");
app.post("/mcp", async (req, res) => {
  const server = createDiscordMcpServer(mcpPkg.version);
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
  } catch (err) {
    console.error("MCP error:", err.message);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  }
});

// Command API
app.post("/api/command", async (req, res) => {
  try {
    const { command } = req.body;
    if (!command || typeof command !== "string") return res.status(400).json({ success: false, message: "Missing command" });
    const { action, params } = await parseCommand(command);
    if (action === "UNKNOWN") return res.status(400).json({ success: false, message: params?.reason || "Could not understand" });
    const result = await executeAction(action, params);
    res.status(result.success ? 200 : 400).json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Health
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Serve React frontend
const webDist = path.join(__dirname, "..", "web", "dist");
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.use((req, res, next) => {
    if (req.method === "GET" && !req.path.startsWith("/api") && !req.path.startsWith("/mcp") && !req.path.startsWith("/health")) {
      res.sendFile(path.join(webDist, "index.html"));
    } else {
      next();
    }
  });
  console.error(`Serving frontend from ${webDist}`);
} else {
  console.error(`Frontend build not found at ${webDist}`);
}

// ─── Start ───────────────────────────────────────────────────────────────

app.listen(PORT, "0.0.0.0", () => {
  console.error(`Server running on port ${PORT}`);
  console.error(`Health: http://0.0.0.0:${PORT}/health`);
});

startGeminiBot().catch((err) => console.error("Gemini bot failed:", err.message));

function shutdown() {
  shutdownGeminiBot();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
