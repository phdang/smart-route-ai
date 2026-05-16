// src/bot.js
import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { initRedis } from "./cache.js";
import {
  getBestRoute,
  getDetailedCheck,
  getAreaTraffic,
  searchLocations,
  resolveLocationValue,
} from "./routeService.js";
import { parseRouteCommand, parseCheckCommand, parseTrafficCommand } from "./parser.js";
import { formatReply, formatCheckReply, formatTrafficReply } from "./formatter.js";
import { parseCommandWithAI } from "./llmService.js";

const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID;
const ALLOWED_CHANNEL_ID = process.env.ALLOWED_CHANNEL_ID;

// Helper to extract a readable label from a packed value (vm:coords|id|label or mb:coords|label)
function getCleanLabel(val) {
  if (!val) return "Địa điểm không xác định";
  if (val.includes("|")) {
    const parts = val.split("|");
    return parts[parts.length - 1]; // Take the last part (label)
  }
  return val;
}

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
function isAllowedMsg(msg) {
  return msg.channelId === ALLOWED_CHANNEL_ID && msg.author.id === ALLOWED_USER_ID;
}
function isAllowedInteraction(interaction) {
  return interaction.user.id === ALLOWED_USER_ID;
}

// ─── Rate Limit ───────────────────────────────────────────────────────────
const cooldowns = new Map();
const COOLDOWN_MS = 3000;

function isOnCooldown(userId) {
  const last = cooldowns.get(userId);
  return last && Date.now() - last < COOLDOWN_MS;
}
function setCooldown(userId) {
  cooldowns.set(userId, Date.now());
  setTimeout(() => cooldowns.delete(userId), 60_000);
}

// ─── Utility: Split long messages ─────────────────────────────────────────
function splitMessage(text, limit = 1800) {
  if (text.length <= limit) return [text];
  const lines = text.split("\n");
  const chunks = [];
  let current = "";
  for (const line of lines) {
    if (line.length > limit) {
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

// ─── Safe interaction helpers ─────────────────────────────────────────────
async function safeDefer(interaction, type = "update") {
  try {
    if (interaction.deferred || interaction.replied) return true;
    if (type === "reply") await interaction.deferReply();
    else await interaction.deferUpdate();
    return true;
  } catch (e) {
    if (e.code === 10062 || e.code === 40060) return false;
    throw e;
  }
}

// ─── Help text ────────────────────────────────────────────────────────────
const HELP_TEXT = `
1. 🗺️ **Smart Route AI — Hướng dẫn sử dụng**

**Slash Commands (gõ / ):**
\`/route [origin] [destination]\` — So sánh lộ trình, hiển thị phí BOT/Phà
\`/check [origin] [destination]\` — Kiểm tra tắc đường + AI Game Theory
\`/traffic [location]\` — Kiểm tra giao thông tại một khu vực

**Prefix Commands (gõ ! ):**
\`!route A → B\` • \`!check A → B\` • \`!traffic [địa điểm]\` • \`!help\`

💡 *Bot tự động chọn địa điểm khớp nhất (Auto-match)*
💡 *Cache 5 phút • AI Game Theory kích hoạt khi CI ≥ 1.25*
`.trim();

// ─── Prefix command handler ───────────────────────────────────────────────
async function handlePrefixCommand(msg) {
  const content = msg.content.trim();

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
  } else if (content.startsWith("!help")) {
    return msg.reply(HELP_TEXT);
  }

  // AI fallback nếu regex thất bại
  if (!parsed && intent) {
    await msg.react("🤖");
    const aiResult = await parseCommandWithAI(content);
    if (aiResult && aiResult.intent !== "unknown") {
      intent = aiResult.intent;
      parsed = { origin: aiResult.origin, dest: aiResult.destination };
    }
  }

  if (!parsed) {
    return msg.reply("❓ Không hiểu lệnh. Thử: `!check A -> B` hoặc dùng `/check`.");
  }

  await msg.react("⏳");

  try {
    if (intent === "route" || intent === "check") {
      const [originOptions, destOptions] = await Promise.all([
        searchLocations(parsed.origin),
        searchLocations(parsed.dest),
      ]);

      if (!originOptions?.length || !destOptions?.length) {
        return msg.reply("❌ Không tìm thấy một hoặc cả hai địa điểm.");
      }

      const bestOrigin = originOptions[0];
      const bestDest = destOptions[0];
      
      const originLabel = bestOrigin.label;
      const destLabel = bestDest.label;

      await msg.reply(`⏳ Đang xử lý lộ trình từ **${originLabel}** đến **${destLabel}**...`);

      try {
        const [start, end] = await Promise.all([
          resolveLocationValue(bestOrigin.value),
          resolveLocationValue(bestDest.value),
        ]);
        
        const parsedNames = { origin: originLabel, dest: destLabel };
        const res = intent === "route"
          ? await getBestRoute(start, end)
          : await getDetailedCheck(start, end);
          
        const chunks = splitMessage(
          intent === "route"
            ? formatReply(res, parsedNames)
            : formatCheckReply(res, parsedNames)
        );
        for (const chunk of chunks) {
          await msg.channel.send(chunk);
        }
      } catch (e) {
        console.error(`[Prefix ${intent} Execution Error]`, e.message);
        await msg.reply(`⚠️ Lỗi: ${e.message}`);
      }

    } else if (intent === "traffic") {
      const locations = await searchLocations(parsed.origin);
      if (!locations?.length) return msg.reply("❌ Không tìm thấy địa điểm nào.");

      const bestMatch = locations[0];
      const label = bestMatch.label;
      
      await msg.reply(`⏳ Đang kiểm tra giao thông cho: **${label}**...`);
      
      try {
        const coords = await resolveLocationValue(bestMatch.value);
        if (!coords) return msg.reply("❌ Không thể xác định tọa độ.");
        const result = await getAreaTraffic(coords, label);
        await msg.reply({ content: formatTrafficReply(result, label) });
      } catch (e) {
        console.error("[Prefix Traffic Error]", e.message);
        await msg.reply(`⚠️ Lỗi: ${e.message}`);
      }
    }
  } catch (e) {
    console.error(`[Prefix ${intent} Error]`, e.message);
    await msg.reply(`⚠️ Lỗi: ${e.message}`);
  }
}

// ─── Message handler ──────────────────────────────────────────────────────
client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  if (!isAllowedMsg(msg)) return;
  if (!msg.content.startsWith("!")) return;

  if (isOnCooldown(msg.author.id)) {
    return msg.reply("⏱ Vui lòng chờ vài giây trước lệnh tiếp theo.");
  }
  setCooldown(msg.author.id);

  return handlePrefixCommand(msg);
});

// ─── Interaction handler ──────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {

  // ── 1. Autocomplete ──────────────────────────────────────────────────
  if (interaction.isAutocomplete()) {
    const focusedValue = interaction.options.getFocused();
    if (!focusedValue || focusedValue.length < 2) return interaction.respond([]);
    
    if (focusedValue.startsWith("vm:") || focusedValue.startsWith("mb:") || focusedValue.startsWith("vmc:")) {
      return interaction.respond([]);
    }

    try {
      const locations = await searchLocations(focusedValue);
      await interaction.respond(
        locations.slice(0, 25).map(loc => ({
          name: `${loc.label}${loc.description && loc.description !== loc.label ? ` (${loc.description})` : ""}`.substring(0, 100),
          value: String(loc.value).substring(0, 100),
        }))
      );
    } catch (e) {
      console.error("[Autocomplete Error]", e.message);
      try { await interaction.respond([]); } catch { }
    }
    return;
  }

  // ── 2. Slash Commands ──────────────────────────────────────────────────
  if (interaction.isChatInputCommand()) {
    if (!isAllowedInteraction(interaction)) {
      const ok = await safeDefer(interaction, "reply");
      if (!ok) return;
      return interaction.editReply("❌ Bạn không có quyền sử dụng lệnh này.");
    }

    const ok = await safeDefer(interaction, "reply");
    if (!ok) return;

    const { commandName } = interaction;

    try {
      if (commandName === "traffic") {
        const query = interaction.options.getString("location");

        let bestMatchValue = query;
        let label = getCleanLabel(query);

        if (!query.startsWith("vm:") && !query.startsWith("mb:") && !query.startsWith("vmc:")) {
          const locations = await searchLocations(query);
          if (!locations?.length) return interaction.editReply("❌ Không tìm thấy địa điểm nào.");
          bestMatchValue = locations[0].value;
          label = locations[0].label;
        }

        const coords = await resolveLocationValue(bestMatchValue);
        const result = await getAreaTraffic(coords, label);
        return interaction.editReply({ content: formatTrafficReply(result, label) });

      } else if (commandName === "check" || commandName === "route") {
        let originVal = interaction.options.getString("origin");
        let destVal = interaction.options.getString("destination");
        
        // Auto-match if raw strings
        if (!originVal.includes("|") && !originVal.startsWith("mb:") && !originVal.startsWith("vm:")) {
          const locs = await searchLocations(originVal);
          if (locs?.length) originVal = locs[0].value;
        }
        if (!destVal.includes("|") && !destVal.startsWith("mb:") && !destVal.startsWith("vm:")) {
          const locs = await searchLocations(destVal);
          if (locs?.length) destVal = locs[0].value;
        }

        const [start, end] = await Promise.all([
          resolveLocationValue(originVal),
          resolveLocationValue(destVal),
        ]);
        
        if (!start || !end) {
          return interaction.editReply("❌ Không tìm thấy tọa độ điểm đi hoặc điểm đến.");
        }
        
        const originLabel = getCleanLabel(originVal);
        const destLabel = getCleanLabel(destVal);
        const parsedNames = { origin: originLabel, dest: destLabel };
        
        const res = commandName === "route"
          ? await getBestRoute(start, end)
          : await getDetailedCheck(start, end);
          
        const chunks = splitMessage(
          commandName === "route"
            ? formatReply(res, parsedNames)
            : formatCheckReply(res, parsedNames)
        );
        for (const [i, chunk] of chunks.entries()) {
          if (i === 0) await interaction.editReply({ content: chunk });
          else await interaction.followUp({ content: chunk });
        }
      }
    } catch (e) {
      console.error(`[Slash /${commandName} Error]`, e.message);
      try { await interaction.editReply(`⚠️ Lỗi: ${e.message}`); } catch { }
    }
    return;
  }

  // 3. Message Components (Disabled - Now using Auto-match)
  if (interaction.isMessageComponent()) {
    try { await interaction.reply({ content: "❌ Chế độ Dropdown đã được thay bằng Tự động khớp (Auto-match). Vui lòng dùng lệnh trực tiếp.", ephemeral: true }); } catch {}
  }
});

// ─── Startup ──────────────────────────────────────────────────────────────
client.once("clientReady", () => {
  console.log(`✅ Smart Route AI online: ${client.user.tag}`);
  console.log(`📌 Channel: ${ALLOWED_CHANNEL_ID}`);
  console.log(`👤 User:    ${ALLOWED_USER_ID}`);
});

// ─── Graceful shutdown ────────────────────────────────────────────────────
process.on("SIGINT", () => { client.destroy(); process.exit(0); });
process.on("SIGTERM", () => { client.destroy(); process.exit(0); });
process.on("unhandledRejection", (reason) => {
  console.error("[UNHANDLED REJECTION]", reason);
});

async function startBot() {
  try {
    await initRedis();
    await client.login(process.env.DISCORD_TOKEN);
    console.log("[Bot] Login successful");
  } catch (err) {
    console.error("[FATAL] Startup failed:", err);
    setTimeout(() => process.exit(1), 2000);
  }
}

startBot();