// src/bot.js
import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import { initRedis } from "./cache.js";
import { getBestRoute, getDetailedCheck, getAreaTraffic } from "./routeService.js";
import { parseRouteCommand, parseCheckCommand, parseTrafficCommand } from "./parser.js";
import { formatReply, formatCheckReply, formatTrafficReply } from "./formatter.js";
import { parseCommandWithAI } from "./llmService.js";

const ALLOWED_USER_ID    = process.env.ALLOWED_USER_ID;
const ALLOWED_CHANNEL_ID = process.env.ALLOWED_CHANNEL_ID;

// Fail fast if required variables are missing
if (!ALLOWED_USER_ID || !ALLOWED_CHANNEL_ID) {
  console.error("[FATAL] Missing ALLOWED_USER_ID or ALLOWED_CHANNEL_ID in .env");
  process.exit(1);
}
if (!process.env.MAPBOX_ACCESS_TOKEN) {
  console.error("[FATAL] Missing MAPBOX_ACCESS_TOKEN in .env");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ─── Auth guard ───────────────────────────────────────────────────────────
function isAllowed(msg) {
  return (
    msg.channelId === ALLOWED_CHANNEL_ID &&
    msg.author.id === ALLOWED_USER_ID
  );
}

// ─── Simple Rate Limit - Avoid Spam ───────────────────────────────────────
const cooldowns = new Map(); // userId → timestamp
const COOLDOWN_MS = 3000;   // 3 seconds between commands

function isOnCooldown(userId) {
  const last = cooldowns.get(userId);
  if (!last) return false;
  return Date.now() - last < COOLDOWN_MS;
}
function setCooldown(userId) {
  cooldowns.set(userId, Date.now());
  // Auto cleanup after 1 minute to prevent memory leak
  setTimeout(() => cooldowns.delete(userId), 60_000);
}

// ─── Smart Command Handling (Regex + AI Fallback) ────────────────────────
async function handleSmartCommand(msg) {
  const content = msg.content.trim();
  
  // 1. Try traditional regex first (fast & cheap)
  let parsed = null;
  let intent = null;

  if (content.startsWith("!route")) {
    intent = "route";
    parsed = parseRouteCommand(content);
  } else if (content.startsWith("!check")) {
    intent = "check";
    parsed = parseCheckCommand(content);
  } else if (content.startsWith("!traffic")) {
    intent = "traffic";
    parsed = parseTrafficCommand(content);
  }

  // 2. If regex fails -> Ask AI to understand natural language
  if (!parsed && (content.startsWith("!check") || content.startsWith("!route") || content.startsWith("!traffic"))) {
    await msg.react("🤖"); // AI is processing
    const aiResult = await parseCommandWithAI(content);
    if (aiResult && aiResult.intent !== "unknown") {
      intent = aiResult.intent;
      parsed = { origin: aiResult.origin, dest: aiResult.destination };
    }
  }

  if (!parsed) {
    if (content.startsWith("!help")) return handleHelp(msg);
    return msg.reply("❓ I didn't understand that. Try standard syntax: `!check A → B` or describe it clearly.");
  }

  // 3. Execute based on intent
  await msg.react("⏳");
  try {
    if (intent === "route") {
      const result = await getBestRoute(parsed.origin, parsed.dest);
      const chunks = splitMessage(formatReply(result, parsed));
      for (const chunk of chunks) await msg.reply(chunk);
    } else if (intent === "check") {
      const result = await getDetailedCheck(parsed.origin, parsed.dest);
      const chunks = splitMessage(formatCheckReply(result, parsed));
      for (const chunk of chunks) await msg.reply(chunk);
    } else if (intent === "traffic") {
      const route = await getAreaTraffic(parsed.origin);
      await msg.reply(formatTrafficReply(route, parsed.origin));
    } else if (intent === "help") {
      await handleHelp(msg);
    }
  } catch (e) {
    console.error(`[${intent} error]`, e.message);
    await msg.reply(`⚠️ Error: ${e.message}`);
  }
}

// ─── Utility: Split long messages ─────────────────────────────────────────
function splitMessage(text, limit = 1800) {
  if (text.length <= limit) return [text];
  const lines = text.split("\n");
  const chunks = [];
  let current = "";
  for (const line of lines) {
    if (line.length > limit) {
      // Emergency split for very long single lines
      if (current) chunks.push(current);
      chunks.push(line.substring(0, limit));
      current = line.substring(limit) + "\n";
      continue;
    }
    if ((current + line).length > limit) {
      chunks.push(current.trim());
      current = "";
    }
    current += line + "\n";
  }
  if (current) chunks.push(current.trim());
  return chunks;
}

// ─── Help Handler ─────────────────────────────────────────────────────────
async function handleHelp(msg) {
  await msg.reply(`
🗺️ **Smart Route AI — User Guide**

\`!route [origin] → [destination]\`
> Compare highway vs non-highway routes, show BOT/Ferry fees
> *Ex:* \`!route Quận 1 → Sân bay Tân Sơn Nhất\`

\`!check [origin] → [destination]\`
> Check congestion + AI Game Theory for optimal route
> *Ex:* \`!check Quận 1 → Vũng Tàu\`

\`!traffic [location]\`
> Quick report on traffic status at a specific area
> *Ex:* \`!traffic Ngã tư Hàng Xanh\`

\`!help\` — Show this guide

💡 *Bot supports natural language (Ex: !check from A to B)*
💡 *Cache 5 mins • AI Game Theory triggered automatically when CI ≥ 1.5*
`.trim());
}

// ─── Message handler ──────────────────────────────────────────────────────
client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  if (!isAllowed(msg)) return;

  const content = msg.content.trim();
  if (!content.startsWith("!")) return; // Skip normal messages

  // Rate limit check
  if (isOnCooldown(msg.author.id)) {
    return msg.reply("⏱ Please wait a few seconds before the next command.");
  }
  setCooldown(msg.author.id);

  // Handle all commands via smart filter
  return handleSmartCommand(msg);
});

// ─── Startup ──────────────────────────────────────────────────────────────
client.once("clientReady", () => {
  console.log(`✅ Smart Route AI online: ${client.user.tag}`);
  console.log(`📌 Channel: ${ALLOWED_CHANNEL_ID}`);
  console.log(`👤 User:    ${ALLOWED_USER_ID}`);
});

// ─── Graceful shutdown ────────────────────────────────────────────────────
process.on("SIGINT",  () => { client.destroy(); process.exit(0); });
process.on("SIGTERM", () => { client.destroy(); process.exit(0); });
process.on("unhandledRejection", (reason) => {
  console.error("[UNHANDLED]", reason);
});

await initRedis();
client.login(process.env.DISCORD_TOKEN);
