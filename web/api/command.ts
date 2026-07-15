declare var process: { env: Record<string, string | undefined> };

const DISCORD_API = "https://discord.com/api/v10";
const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent";

const SYSTEM_PROMPT = `You are a Discord server manager. Parse the request and respond with JSON only.

Actions: LIST_GUILDS (no params), LIST_CHANNELS (guild_id), CREATE_CHANNEL (guild_id, name, type=0|2|4, topic?, parent_id?), EDIT_CHANNEL (channel_id, name?, topic?), DELETE_CHANNEL (channel_id), SEND_MESSAGE (channel_id, content)

Channel types: 0=text, 2=voice, 4=category

Response format: { "action": "ACTION", "params": { ... } }
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

async function parseCommand(command: string) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");

  const res = await fetch(GEMINI_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: command }] }],
      systemInstruction: { role: "user", parts: [{ text: SYSTEM_PROMPT }] },
      generationConfig: { temperature: 0.1, maxOutputTokens: 500 },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini error (${res.status}): ${err.slice(0, 200)}`);
  }

  const data: any = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return JSON.parse(text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""));
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  try {
    const { command } = await req.json();
    if (!command || typeof command !== "string") {
      return new Response(JSON.stringify({ error: "Missing 'command'" }), { status: 400 });
    }

    const { action, params } = await parseCommand(command);

    if (action === "UNKNOWN") {
      return new Response(JSON.stringify({ success: false, message: params?.reason || "Could not understand" }), { status: 400 });
    }

    let result: any;

    switch (action) {
      case "LIST_GUILDS": {
        const guilds = await discordFetch("/users/@me/guilds");
        result = { success: true, message: guilds.map((g: any) => `${g.name} (id: ${g.id})`).join("\n") };
        break;
      }
      case "LIST_CHANNELS": {
        const channels = await discordFetch(`/guilds/${params.guild_id}/channels`);
        const list = channels.filter((c: any) => [0, 2, 4].includes(c.type))
          .map((c: any) => `#${c.name} (${["text", "voice", "category"][c.type]}, id: ${c.id})`).join("\n");
        result = { success: true, message: list || "No channels found" };
        break;
      }
      case "CREATE_CHANNEL": {
        const body: Record<string, unknown> = { name: params.name, type: params.type ?? 0 };
        if (params.topic) body.topic = params.topic;
        if (params.parent_id) body.parent_id = params.parent_id;
        const channel = await discordFetch(`/guilds/${params.guild_id}/channels`, { method: "POST", body: JSON.stringify(body) });
        const t = ["text", "voice", "category"][channel.type] || "channel";
        result = { success: true, message: `Created ${t} channel #${channel.name}` };
        break;
      }
      case "EDIT_CHANNEL": {
        const body: Record<string, unknown> = {};
        if (params.name) body.name = params.name;
        if (params.topic !== undefined) body.topic = params.topic;
        await discordFetch(`/channels/${params.channel_id}`, { method: "PATCH", body: JSON.stringify(body) });
        result = { success: true, message: "Channel updated" };
        break;
      }
      case "DELETE_CHANNEL": {
        await discordFetch(`/channels/${params.channel_id}`, { method: "DELETE" });
        result = { success: true, message: "Channel deleted" };
        break;
      }
      case "SEND_MESSAGE": {
        await discordFetch(`/channels/${params.channel_id}/messages`, {
          method: "POST",
          body: JSON.stringify({ content: params.content }),
        });
        result = { success: true, message: "Message sent" };
        break;
      }
      default:
        result = { success: false, message: "Unknown action" };
    }

    return new Response(JSON.stringify(result), {
      status: result.success ? 200 : 400,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("Error:", err.message);
    return new Response(JSON.stringify({ success: false, message: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
