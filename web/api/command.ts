declare var process: { env: Record<string, string | undefined> };

export default async function handler(req: Request): Promise<Response> {
  try {
    // Read the raw body first
    const rawBody = await req.text();
    let body: any;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return new Response(JSON.stringify({ success: false, message: "Invalid JSON body" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const command = body?.command || "";

    // Check env vars
    const key = process.env.GEMINI_API_KEY || "";
    const token = process.env.DISCORD_TOKEN || "";

    return new Response(JSON.stringify({
      success: true,
      command,
      keyPresent: key.length > 0,
      keyPrefix: key.substring(0, 8),
      tokenPresent: token.length > 0,
      tokenPrefix: token.substring(0, 8),
    }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ success: false, message: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
