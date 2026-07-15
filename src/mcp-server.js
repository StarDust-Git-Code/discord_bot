const express = require("express");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { createMcpExpressApp } = require("@modelcontextprotocol/sdk/server/express.js");
const { createServer } = require("@pasympa/discord-mcp/dist/server.js");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const PORT = process.env.MCP_PORT || 3000;
const DISCORD_API = "https://discord.com/api/v10";

function initGemini() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const genAI = new GoogleGenerativeAI(key);
  return genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || "gemini-3.1-flash-lite" });
}

async function discordFetch(path, options = {}) {
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN not configured");
  const res = await fetch(`${DISCORD_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.message || JSON.stringify(body));
  return body;
}

const SYSTEM_PROMPT = `You are a Discord server manager. Parse the user's request and respond with JSON only.

Actions:
- LIST_GUILDS — no params
- LIST_CHANNELS — { "guild_id": "snowflake" }
- CREATE_CHANNEL — { "guild_id": "snowflake", "name": "channel-name", "type": 0|2|4, "topic?": "text", "parent_id?": "snowflake" }
- EDIT_CHANNEL — { "channel_id": "snowflake", "name?": "new-name", "topic?": "text" }
- DELETE_CHANNEL — { "channel_id": "snowflake" }
- SEND_MESSAGE — { "channel_id": "snowflake", "content": "text" }

Channel types: 0=text, 2=voice, 4=category

Respond only with JSON: { "action": "ACTION", "params": { ... } }
If unsure: { "action": "UNKNOWN", "params": { "reason": "..." } }`;

async function handleCommand(command) {
  const model = initGemini();
  if (!model) throw new Error("GEMINI_API_KEY not configured");

  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: command }] }],
    systemInstruction: { role: "user", parts: [{ text: SYSTEM_PROMPT }] },
    generationConfig: { temperature: 0.1, maxOutputTokens: 500 },
  });

  const text = result.response.text().trim();
  const parsed = JSON.parse(text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""));
  const { action, params } = parsed;

  if (action === "UNKNOWN") {
    return { success: false, message: params?.reason || "Could not understand the command" };
  }

  switch (action) {
    case "LIST_GUILDS": {
      const guilds = await discordFetch("/users/@me/guilds");
      return { success: true, message: guilds.map((g) => `${g.name} (id: ${g.id})`).join("\n") };
    }
    case "LIST_CHANNELS": {
      const channels = await discordFetch(`/guilds/${params.guild_id}/channels`);
      const list = channels
        .filter((c) => [0, 2, 4].includes(c.type))
        .map((c) => `#${c.name} (${["text", "voice", "category"][c.type]}, id: ${c.id})`)
        .join("\n");
      return { success: true, message: list || "No channels found" };
    }
    case "CREATE_CHANNEL": {
      const body = { name: params.name, type: params.type ?? 0 };
      if (params.topic) body.topic = params.topic;
      if (params.parent_id) body.parent_id = params.parent_id;
      const channel = await discordFetch(`/guilds/${params.guild_id}/channels`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      const typeName = ["text", "voice", "category"][channel.type] || "channel";
      return { success: true, message: `Created ${typeName} channel #${channel.name}` };
    }
    case "EDIT_CHANNEL": {
      const body = {};
      if (params.name) body.name = params.name;
      if (params.topic !== undefined) body.topic = params.topic;
      const channel = await discordFetch(`/channels/${params.channel_id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      return { success: true, message: `Updated channel #${channel.name}` };
    }
    case "DELETE_CHANNEL": {
      await discordFetch(`/channels/${params.channel_id}`, { method: "DELETE" });
      return { success: true, message: `Deleted channel` };
    }
    case "SEND_MESSAGE": {
      await discordFetch(`/channels/${params.channel_id}/messages`, {
        method: "POST",
        body: JSON.stringify({ content: params.content }),
      });
      return { success: true, message: `Message sent` };
    }
    default:
      return { success: false, message: "Unknown action" };
  }
}

function startMcpServer() {
  const mcpApp = createMcpExpressApp();
  const pkg = require("@pasympa/discord-mcp/package.json");

  mcpApp.post("/mcp", async (req, res) => {
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

  mcpApp.use(express.json());

  mcpApp.post("/api/command", async (req, res) => {
    try {
      const { command } = req.body;
      if (!command || typeof command !== "string") {
        return res.status(400).json({ success: false, message: "Missing 'command' field" });
      }
      const result = await handleCommand(command);
      res.status(result.success ? 200 : 400).json(result);
    } catch (err) {
      console.error("Command API error:", err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  });

  mcpApp.get("/health", (_req, res) => res.json({ status: "ok" }));

  mcpApp.listen(PORT, () => {
    console.error(`Server listening on port ${PORT}`);
    console.error(`MCP endpoint: http://localhost:${PORT}/mcp`);
    console.error(`Command API: http://localhost:${PORT}/api/command`);
  });

  return mcpApp;
}

module.exports = { startMcpServer };
