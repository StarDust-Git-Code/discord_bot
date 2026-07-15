const express = require("express");
const path = require("path");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { createMcpExpressApp } = require("@modelcontextprotocol/sdk/server/express.js");
const { createServer } = require("@pasympa/discord-mcp/dist/server.js");
const { start: startGeminiBot, shutdown: shutdownGeminiBot } = require("./gemini-bot.js");

const PORT = process.env.PORT || 3000;
const DISCORD_API = "https://discord.com/api/v10";

// ─── Gemini + Discord command handler ────────────────────────────────────

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
        systemInstruction: { role: "user", parts: [{ text: `Parse the request and respond with JSON only.
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
      const guilds = await discordFetch("/users/@me/guilds");
      return { success: true, message: guilds.map((g) => `${g.name} (id: ${g.id})`).join("\n") };
    }
    case "LIST_CHANNELS": {
      const channels = await discordFetch(`/guilds/${params.guild_id}/channels`);
      const list = channels.filter((c) => [0, 2, 4].includes(c.type))
        .map((c) => `#${c.name} (${["text", "voice", "category"][c.type]}, id: ${c.id})`).join("\n");
      return { success: true, message: list || "No channels" };
    }
    case "CREATE_CHANNEL": {
      const body = { name: params.name, type: params.type ?? 0 };
      if (params.topic) body.topic = params.topic;
      if (params.parent_id) body.parent_id = params.parent_id;
      const ch = await discordFetch(`/guilds/${params.guild_id}/channels`, { method: "POST", body: JSON.stringify(body) });
      return { success: true, message: `Created ${["text", "voice", "category"][ch.type] || "channel"} #${ch.name}` };
    }
    case "EDIT_CHANNEL": {
      const body = {};
      if (params.name) body.name = params.name;
      if (params.topic !== undefined) body.topic = params.topic;
      await discordFetch(`/channels/${params.channel_id}`, { method: "PATCH", body: JSON.stringify(body) });
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

// ─── Build the Express app ───────────────────────────────────────────────

const app = createMcpExpressApp();
app.use(express.json());

// MCP endpoint
const pkg = require("@pasympa/discord-mcp/package.json");
app.post("/mcp", async (req, res) => {
  const server = createServer(pkg.version);
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

// Serve React frontend
const webDist = path.join(__dirname, "..", "web", "dist");
app.use(express.static(webDist));
app.get("*", (_req, res) => res.sendFile(path.join(webDist, "index.html")));

// Health
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ─── Start ───────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.error(`Server on port ${PORT}`);
  console.error(`Frontend: http://localhost:${PORT}`);
  console.error(`MCP: http://localhost:${PORT}/mcp`);
  console.error(`API: http://localhost:${PORT}/api/command`);
});

startGeminiBot().catch((err) => console.error("Gemini bot failed:", err.message));

function shutdown() {
  shutdownGeminiBot();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
