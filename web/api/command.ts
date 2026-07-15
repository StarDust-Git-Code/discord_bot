declare var process: { env: Record<string, string | undefined> };
declare function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;

const RENDER_API = process.env.RENDER_API_URL || "http://localhost:3000";
const DISCORD_API = "https://discord.com/api/v10";
const TIMEOUT_MS = 15000;

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

async function discordFetch(path: string, options: RequestInit = {}) {
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN not set");
  const res = await fetch(`${DISCORD_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string>),
    },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.message || JSON.stringify(body));
  return body;
}

async function handleDirect(command: string) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");

  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const genAI = new GoogleGenerativeAI(key);
  const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite" });

  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: command }] }],
    systemInstruction: { role: "user", parts: [{ text: SYSTEM_PROMPT }] },
    generationConfig: { temperature: 0.1, maxOutputTokens: 500 },
  });

  const text = result.response.text().trim();
  const parsed = JSON.parse(text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""));
  const { action, params } = parsed;

  if (action === "UNKNOWN") {
    return { success: false, message: params?.reason || "Could not understand command" };
  }

  switch (action) {
    case "LIST_GUILDS": {
      const guilds = await discordFetch("/users/@me/guilds");
      return { success: true, message: guilds.map((g: any) => `${g.name} (id: ${g.id})`).join("\n") };
    }
    case "LIST_CHANNELS": {
      const channels = await discordFetch(`/guilds/${params.guild_id}/channels`);
      const list = channels
        .filter((c: any) => [0, 2, 4].includes(c.type))
        .map((c: any) => `#${c.name} (${["text", "voice", "category"][c.type]}, id: ${c.id})`)
        .join("\n");
      return { success: true, message: list || "No channels" };
    }
    case "CREATE_CHANNEL": {
      const body: Record<string, unknown> = { name: params.name, type: params.type ?? 0 };
      if (params.topic) body.topic = params.topic;
      if (params.parent_id) body.parent_id = params.parent_id;
      const channel = await discordFetch(`/guilds/${params.guild_id}/channels`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      return { success: true, message: `Created ${["text", "voice", "category"][channel.type] || "channel"} #${channel.name}` };
    }
    case "EDIT_CHANNEL": {
      const body: Record<string, unknown> = {};
      if (params.name) body.name = params.name;
      if (params.topic !== undefined) body.topic = params.topic;
      await discordFetch(`/channels/${params.channel_id}`, { method: "PATCH", body: JSON.stringify(body) });
      return { success: true, message: `Channel updated` };
    }
    case "DELETE_CHANNEL": {
      await discordFetch(`/channels/${params.channel_id}`, { method: "DELETE" });
      return { success: true, message: `Channel deleted` };
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

async function tryRender(command: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${RENDER_API}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command }),
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timer);
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

    // Try Render backend first, fall back to direct Gemini + Discord
    try {
      const renderRes = await tryRender(command);
      if (renderRes.ok) {
        const data = await renderRes.json();
        return new Response(JSON.stringify(data), {
          status: renderRes.status,
          headers: { "Content-Type": "application/json" },
        });
      }
      console.error("Render returned", renderRes.status, "- falling back to direct");
    } catch (e: any) {
      console.error("Render unreachable:", e.message);
    }

    // Fallback: direct Gemini + Discord
    const data = await handleDirect(command);
    return new Response(JSON.stringify(data), {
      status: data.success ? 200 : 400,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("API error:", err.message);
    return new Response(JSON.stringify({ success: false, message: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
