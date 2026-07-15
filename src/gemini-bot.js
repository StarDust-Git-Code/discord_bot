const { Client, GatewayIntentBits, Events } = require("discord.js");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
const BOT_PREFIX = process.env.BOT_PREFIX || "!ask";
const ALLOWED_CHANNELS = (process.env.GEMINI_ALLOWED_CHANNELS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

let genAI, model;

function initGemini() {
  if (!GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY not set — Gemini bot will not respond to messages");
    return false;
  }
  genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
  return true;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, () => {
  console.error(`Gemini bot logged in as ${client.user?.tag}`);
});

client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot) return;
  if (!model) return;

  const isMentioned = msg.mentions.has(client.user);
  const hasPrefix = msg.content.startsWith(BOT_PREFIX);
  const isAllowedChannel = ALLOWED_CHANNELS.length === 0 || ALLOWED_CHANNELS.includes(msg.channelId);

  if (!isMentioned && !hasPrefix && !isAllowedChannel) return;

  let prompt = msg.content;
  if (hasPrefix) prompt = msg.content.slice(BOT_PREFIX.length).trim();
  if (isMentioned) prompt = prompt.replace(/<@!?\d+>/g, "").trim();
  if (!prompt) return;

  await msg.channel.sendTyping();
  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    if (text) await msg.reply(text.slice(0, 2000));
  } catch (err) {
    console.error("Gemini API error:", err.message);
    await msg.reply(`Error: ${err.message}`).catch(() => {});
  }
});

async function start() {
  if (!TOKEN) {
    console.error("DISCORD_TOKEN is required for Gemini bot");
    return;
  }
  if (!initGemini()) return;
  await client.login(TOKEN);
}

function shutdown() {
  client.destroy();
}

module.exports = { start, shutdown, client };
