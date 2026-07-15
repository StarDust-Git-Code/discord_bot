import { GoogleGenerativeAI } from "@google/generative-ai";

const DISCORD_API = "https://discord.com/api/v10";

interface CommandResult {
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
}

async function discordFetch(path: string, options: RequestInit = {}) {
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

function getSystemPrompt() {
  return `You are a Discord server manager. Parse the user's request and respond with a JSON object.

Available actions:
- LIST_GUILDS — no parameters
- LIST_CHANNELS — { "guild_id": "snowflake string" }
- CREATE_CHANNEL — { "guild_id": "snowflake", "name": "channel-name", "type": 0|2|4, "topic?": "optional text", "parent_id?": "snowflake" }
- EDIT_CHANNEL — { "channel_id": "snowflake", "name?": "new-name", "topic?": "text", "type?": 0|2 }
- DELETE_CHANNEL — { "channel_id": "snowflake" }
- SEND_MESSAGE — { "channel_id": "snowflake", "content": "text" }

Channel types: 0=text, 2=voice, 4=category

Only respond with valid JSON: { "action": "ACTION_NAME", "params": { ... } }
If unsure, set action to "UNKNOWN" with params.reason.`;
}

function buildChannelList(channels: any[]): string {
  return channels
    .filter((c) => [0, 2, 4, 5, 13, 15, 16].includes(c.type))
    .map((c) => `  #${c.name} (${["text", "dm", "voice", "group", "category", "announcement", "announcement-thread", "public-thread", "private-thread", "stage", "directory", "forum", "media"][c.type] || "unknown"}, id: ${c.id})`)
    .join("\n");
}

async function executeAction(action: string, params: Record<string, any>, context: { guilds: any[], channels: any[][] }): Promise<CommandResult> {
  switch (action) {
    case "LIST_GUILDS": {
      const guilds = await discordFetch("/users/@me/guilds");
      return { success: true, message: `Servers:\n${guilds.map((g: any) => `  ${g.name} (id: ${g.id})`).join("\n")}`, data: { guilds } };
    }
    case "LIST_CHANNELS": {
      const channels = await discordFetch(`/guilds/${params.guild_id}/channels`);
      return { success: true, message: `Channels:\n${buildChannelList(channels)}`, data: { channels } };
    }
    case "CREATE_CHANNEL": {
      const body: Record<string, unknown> = { name: params.name, type: params.type ?? 0 };
      if (params.topic) body.topic = params.topic;
      if (params.parent_id) body.parent_id = params.parent_id;
      const channel = await discordFetch(`/guilds/${params.guild_id}/channels`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      const typeName = ["text", "dm", "voice", "group", "category"][channel.type] || "channel";
      return { success: true, message: `Created ${typeName} channel #${channel.name} (id: ${channel.id})`, data: { channel } };
    }
    case "EDIT_CHANNEL": {
      const body: Record<string, unknown> = {};
      if (params.name) body.name = params.name;
      if (params.topic !== undefined) body.topic = params.topic;
      const channel = await discordFetch(`/channels/${params.channel_id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      return { success: true, message: `Updated channel #${channel.name}`, data: { channel } };
    }
    case "DELETE_CHANNEL": {
      await discordFetch(`/channels/${params.channel_id}`, { method: "DELETE" });
      return { success: true, message: `Deleted channel ${params.channel_id}`, data: {} };
    }
    case "SEND_MESSAGE": {
      const msg = await discordFetch(`/channels/${params.channel_id}/messages`, {
        method: "POST",
        body: JSON.stringify({ content: params.content }),
      });
      return { success: true, message: `Message sent to <#${params.channel_id}>`, data: { message: msg } };
    }
    default:
      return { success: false, message: params.reason || "Unknown action" };
  }
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  try {
    const { command } = await req.json();
    if (!command || typeof command !== "string") {
      return new Response(JSON.stringify({ error: "Missing 'command' field" }), { status: 400 });
    }

    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) throw new Error("GEMINI_API_KEY not configured");

    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite" });

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: command }] }],
      systemInstruction: { role: "user", parts: [{ text: getSystemPrompt() }] },
      generationConfig: { temperature: 0.1, maxOutputTokens: 500 },
    });

    const text = result.response.text().trim();
    const parsed = JSON.parse(text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""));
    const { action, params } = parsed;

    if (action === "UNKNOWN") {
      return new Response(JSON.stringify({ success: false, message: params?.reason || "Could not understand the command" }), { status: 400 });
    }

    const guilds = action === "LIST_GUILDS" ? [] : await discordFetch("/users/@me/guilds");
    const outcome = await executeAction(action, params || {}, { guilds, channels: [] });
    return new Response(JSON.stringify(outcome), {
      status: outcome.success ? 200 : 400,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("API error:", err);
    return new Response(JSON.stringify({ success: false, message: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
