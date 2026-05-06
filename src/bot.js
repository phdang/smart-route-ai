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

// ─── Safe defer helpers ───────────────────────────────────────────────────
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

async function safeUpdate(interaction, data) {
  try {
    await interaction.update(data);
    return true;
  } catch (e) {
    if (e.code === 10062 || e.code === 40060) return false;
    throw e;
  }
}

// ─── Help message ─────────────────────────────────────────────────────────
const HELP_TEXT = `
🗺️ **Smart Route AI — Hướng dẫn sử dụng**

**Slash Commands (gõ / để dùng):**
\`/route [origin] [destination]\` — So sánh lộ trình, hiển thị phí BOT/Phà
\`/check [origin] [destination]\` — Kiểm tra tắc đường + AI Game Theory
\`/traffic [location]\` — Kiểm tra giao thông tại một khu vực

**Prefix Commands (gõ ! để dùng):**
\`!route A → B\`, \`!check A → B\`, \`!traffic [địa điểm]\`, \`!help\`

💡 *Slash commands hỗ trợ autocomplete địa điểm*
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
    return msg.reply("❓ Không hiểu lệnh. Thử: `!check A → B` hoặc dùng `/check` với autocomplete.");
  }

  await msg.react("⏳");

  try {
    if (intent === "route" || intent === "check") {
      const [originLocations, destLocations] = await Promise.all([
        searchLocations(parsed.origin),
        searchLocations(parsed.dest),
      ]);

      if (!originLocations?.length || !destLocations?.length) {
        return msg.reply("❌ Không tìm thấy một hoặc cả hai địa điểm.");
      }

      const row1 = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`select_origin_${intent}`)
          .setPlaceholder(`Chọn điểm đi cho "${parsed.origin}"`)
          .addOptions(originLocations)
      );
      const row2 = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`select_dest_${intent}`)
          .setPlaceholder(`Chọn điểm đến cho "${parsed.dest}"`)
          .addOptions(destLocations)
      );
      const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`confirm_route_${intent}`)
          .setLabel("Xác nhận & Kiểm tra")
          .setStyle(ButtonStyle.Primary)
      );

      await msg.reply({
        content: `Vui lòng xác nhận điểm đi và điểm đến cho lộ trình **${parsed.origin} → ${parsed.dest}**:`,
        components: [row1, row2, row3],
      });
    } else if (intent === "traffic") {
      const locations = await searchLocations(parsed.origin);
      if (!locations?.length) return msg.reply("❌ Không tìm thấy địa điểm nào.");

      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("select_traffic_loc")
          .setPlaceholder("Chọn địa điểm chính xác...")
          .addOptions(locations)
      );

      await msg.reply({
        content: `Vui lòng chọn địa điểm cho **"${parsed.origin}"**:`,
        components: [row],
      });
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

  // ── 1. Autocomplete — phải phản hồi ngay, KHÔNG defer ─────────────────
  if (interaction.isAutocomplete()) {
    const focusedValue = interaction.options.getFocused();
    if (!focusedValue || focusedValue.length < 2) return interaction.respond([]);
    try {
      const locations = await searchLocations(focusedValue);
      await interaction.respond(
        locations.slice(0, 25).map(loc => ({
          name: `${loc.label}${loc.description ? ` (${loc.description})` : ""}`.substring(0, 100),
          value: loc.value,
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
      // Phải defer trước khi editReply
      const ok = await safeDefer(interaction, "reply");
      if (!ok) return;
      return interaction.editReply("❌ Bạn không có quyền sử dụng lệnh này.");
    }

    const ok = await safeDefer(interaction, "reply");
    if (!ok) return;

    const { commandName } = interaction;

    try {
      if (commandName === "traffic") {
        const value = interaction.options.getString("location");
        const coords = await resolveLocationValue(value);
        if (!coords) return interaction.editReply("❌ Không thể lấy tọa độ địa điểm này.");
        const result = await getAreaTraffic(coords, value);
        const chunks = splitMessage(formatTrafficReply(result, value));
        for (const [i, chunk] of chunks.entries()) {
          if (i === 0) await interaction.editReply({ content: chunk });
          else await interaction.followUp({ content: chunk });
        }
      } else if (commandName === "check" || commandName === "route") {
        const originVal = interaction.options.getString("origin");
        const destVal = interaction.options.getString("destination");
        const [start, end] = await Promise.all([
          resolveLocationValue(originVal),
          resolveLocationValue(destVal),
        ]);
        if (!start || !end) {
          return interaction.editReply("❌ Không tìm thấy tọa độ điểm đi hoặc điểm đến.");
        }

        const parsedNames = { origin: originVal, dest: destVal };
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

  // ── 3. Message Components (Dropdown & Button) ─────────────────────────
  if (!interaction.isMessageComponent()) return;
  if (!isAllowedInteraction(interaction)) return;

  try {
    // ── Traffic dropdown ─────────────────────────────────────────────────
    if (interaction.customId === "select_traffic_loc") {
      const ok = await safeDefer(interaction, "update");
      if (!ok) return;

      const val = interaction.values[0];
      const opt = interaction.message.components[0].components[0].options.find(o => o.value === val);
      const name = opt?.label ?? "Địa điểm đã chọn";

      await interaction.editReply({
        content: `⏳ Đang kiểm tra giao thông cho: **${name}**...`,
        components: [],
      });

      try {
        const coords = await resolveLocationValue(val);
        if (!coords) return interaction.editReply({ content: "❌ Không thể lấy tọa độ." });
        const result = await getAreaTraffic(coords, name);
        await interaction.editReply({ content: formatTrafficReply(result, name) });
      } catch (e) {
        console.error("[Traffic Select Error]", e.message);
        await interaction.editReply({ content: `⚠️ Lỗi: ${e.message}` });
      }
    }

    // ── Origin / Dest dropdown — chỉ cập nhật UI, dùng update() trực tiếp ─
    else if (
      interaction.customId.startsWith("select_origin_") ||
      interaction.customId.startsWith("select_dest_")
    ) {
      const val = interaction.values[0];
      const isOrigin = interaction.customId.startsWith("select_origin_");

      const newComponents = interaction.message.components.map((row, i) => {
        const builder = ActionRowBuilder.from(row.toJSON());
        if ((isOrigin && i === 0) || (!isOrigin && i === 1)) {
          builder.components[0].setOptions(
            row.components[0].options.map(o => ({ ...o, default: o.value === val }))
          );
        }
        return builder;
      });

      await safeUpdate(interaction, { components: newComponents });
    }

    // ── Confirm button ───────────────────────────────────────────────────
    else if (interaction.customId.startsWith("confirm_route_")) {
      const ok = await safeDefer(interaction, "update");
      if (!ok) return;

      const originOpt = interaction.message.components[0].components[0].options.find(o => o.default);
      const destOpt = interaction.message.components[1].components[0].options.find(o => o.default);

      if (!originOpt || !destOpt) {
        return interaction.followUp({
          content: "⚠️ Vui lòng chọn cả điểm đi và điểm đến trước khi xác nhận!",
          ephemeral: true,
        });
      }

      const intent = interaction.customId.replace("confirm_route_", "");
      await interaction.editReply({
        content: `⏳ Đang xử lý lộ trình từ **${originOpt.label}** đến **${destOpt.label}**...`,
        components: [],
      });

      try {
        const [start, end] = await Promise.all([
          resolveLocationValue(originOpt.value),
          resolveLocationValue(destOpt.value),
        ]);
        const parsedNames = { origin: originOpt.label, dest: destOpt.label };

        const res = intent === "route"
          ? await getBestRoute(start, end)
          : await getDetailedCheck(start, end);
        const chunks = splitMessage(
          intent === "route"
            ? formatReply(res, parsedNames)
            : formatCheckReply(res, parsedNames)
        );
        for (const [i, chunk] of chunks.entries()) {
          if (i === 0) await interaction.editReply({ content: chunk });
          else await interaction.followUp({ content: chunk });
        }
      } catch (e) {
        console.error("[Confirm Button Error]", e.message);
        await interaction.editReply({ content: `⚠️ Lỗi: ${e.message}` });
      }
    }
  } catch (err) {
    if (err.code === 10062 || err.code === 40060) return;
    console.error("[Critical Interaction Error]", err);
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
  console.error("[UNHANDLED]", reason);
});

await initRedis();
client.login(process.env.DISCORD_TOKEN);