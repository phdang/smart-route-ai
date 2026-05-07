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

// ─── Session Store ────────────────────────────────────────────────────────
// Lưu options theo messageId để rebuild component từ data gốc (không dùng toJSON)
// Structure: messageId → { intent, originOptions, destOptions, selectedOrigin, selectedDest }
const SESSION_TTL = 14 * 60 * 1000; // 14 phút (Discord component timeout là 15 phút)
const sessions = new Map();

function createSession(messageId, data) {
  sessions.set(messageId, { ...data, selectedOrigin: null, selectedDest: null });
  setTimeout(() => sessions.delete(messageId), SESSION_TTL);
}

function getSession(messageId) {
  return sessions.get(messageId) ?? null;
}

// ─── Build route components từ session data ───────────────────────────────
function buildRouteComponents(session) {
  const row1 = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`select_origin_${session.intent}`)
      .setPlaceholder("Chọn điểm đi")
      .addOptions(
        session.originOptions.map(o => ({
          ...o,
          default: o.value === session.selectedOrigin,
        }))
      )
  );

  const row2 = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`select_dest_${session.intent}`)
      .setPlaceholder("Chọn điểm đến")
      .addOptions(
        session.destOptions.map(o => ({
          ...o,
          default: o.value === session.selectedDest,
        }))
      )
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm_route_${session.intent}`)
      .setLabel("Xác nhận & Kiểm tra")
      .setStyle(ButtonStyle.Primary)
  );

  return [row1, row2, row3];
}

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

async function safeUpdate(interaction, data) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(data);
    } else {
      await interaction.update(data);
    }
    return true;
  } catch (e) {
    if (e.code === 10062 || e.code === 40060) return false;
    throw e;
  }
}

// ─── Help text ────────────────────────────────────────────────────────────
const HELP_TEXT = `
🗺️ **Smart Route AI — Hướng dẫn sử dụng**

**Slash Commands (gõ / ):**
\`/route [origin] [destination]\` — So sánh lộ trình, hiển thị phí BOT/Phà
\`/check [origin] [destination]\` — Kiểm tra tắc đường + AI Game Theory
\`/traffic [location]\` — Kiểm tra giao thông tại một khu vực

**Prefix Commands (gõ ! ):**
\`!route A → B\` • \`!check A → B\` • \`!traffic [địa điểm]\` • \`!help\`

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
      const [originOptions, destOptions] = await Promise.all([
        searchLocations(parsed.origin),
        searchLocations(parsed.dest),
      ]);

      if (!originOptions?.length || !destOptions?.length) {
        return msg.reply("❌ Không tìm thấy một hoặc cả hai địa điểm.");
      }

      const sessionData = { intent, originOptions, destOptions };
      const components = buildRouteComponents({ ...sessionData, selectedOrigin: null, selectedDest: null });

      const sentMsg = await msg.reply({
        content: `Vui lòng xác nhận điểm đi và điểm đến cho lộ trình **${parsed.origin} → ${parsed.dest}**:`,
        components,
      });

      // Lưu session với messageId thật sau khi gửi
      createSession(sentMsg.id, sessionData);

    } else if (intent === "traffic") {
      const locations = await searchLocations(parsed.origin);
      if (!locations?.length) return msg.reply("❌ Không tìm thấy địa điểm nào.");

      await msg.reply({
        content: `Vui lòng chọn địa điểm cho **"${parsed.origin}"**:`,
        components: [
          new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId("select_traffic_loc")
              .setPlaceholder("Chọn địa điểm chính xác...")
              .addOptions(locations)
          ),
        ],
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

  // ── 1. Autocomplete — trả lời trực tiếp, KHÔNG defer ──────────────────
  if (interaction.isAutocomplete()) {
    const focusedValue = interaction.options.getFocused();
    if (!focusedValue || focusedValue.length < 2) return interaction.respond([]);
    
    // FIX: If the value already starts with a prefix, the user has already selected a choice.
    // We return an empty list to hide the autocomplete menu so they can press Enter.
    if (focusedValue.startsWith("vm:") || focusedValue.startsWith("mb:")) {
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

        // FIX: If query already has a prefix, it's a resolved value from a dropdown or Mapbox autocomplete
        if (query.startsWith("vm:") || query.startsWith("mb:")) {
          const coords = await resolveLocationValue(query);
          if (coords) {
            const label = getCleanLabel(query);
            const result = await getAreaTraffic(coords, label);
            return interaction.editReply({ content: formatTrafficReply(result, label) });
          }
        }

        // Otherwise search (this happens if user types or selects the 'display text' autocomplete)
        const locations = await searchLocations(query);
        if (!locations?.length) {
          return interaction.editReply("❌ Không tìm thấy địa điểm nào.");
        }

        // Always use the first result, no more dropdowns
        const coords = await resolveLocationValue(locations[0].value);
        const label = getCleanLabel(locations[0].value);
        const result = await getAreaTraffic(coords, label);
        return interaction.editReply({ content: formatTrafficReply(result, label) });
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
        const parsedNames = { origin: getCleanLabel(originVal), dest: getCleanLabel(destVal) };
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

  // ── 3. Message Components ──────────────────────────────────────────────
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

    // ── Origin / Dest dropdown ────────────────────────────────────────────
    // Rebuild hoàn toàn từ session data gốc — KHÔNG dùng toJSON()
    else if (
      interaction.customId.startsWith("select_origin_") ||
      interaction.customId.startsWith("select_dest_")
    ) {
      const session = getSession(interaction.message.id);
      if (!session) {
        return safeUpdate(interaction, {
          content: "⚠️ Phiên đã hết hạn (quá 14 phút). Vui lòng gửi lại lệnh.",
          components: [],
        });
      }

      const val = interaction.values[0];
      const isOrigin = interaction.customId.startsWith("select_origin_");

      // Cập nhật selection trong session
      if (isOrigin) session.selectedOrigin = val;
      else session.selectedDest = val;

      // Rebuild components từ data gốc — luôn valid
      const newComponents = buildRouteComponents(session);
      await safeUpdate(interaction, { components: newComponents });
    }

    // ── Confirm button ────────────────────────────────────────────────────
    else if (interaction.customId.startsWith("confirm_route_")) {
      const ok = await safeDefer(interaction, "update");
      if (!ok) return;

      const session = getSession(interaction.message.id);

      let originValue, originLabel, destValue, destLabel;

      if (session?.selectedOrigin && session?.selectedDest) {
        // Lấy từ session (chính xác nhất)
        originValue = session.selectedOrigin;
        destValue = session.selectedDest;
        originLabel = session.originOptions.find(o => o.value === originValue)?.label ?? originValue;
        destLabel = session.destOptions.find(o => o.value === destValue)?.label ?? destValue;
      } else {
        // Fallback: đọc từ message components
        const originOpt = interaction.message.components[0]?.components[0]?.options?.find(o => o.default);
        const destOpt = interaction.message.components[1]?.components[0]?.options?.find(o => o.default);
        if (!originOpt || !destOpt) {
          return interaction.followUp({
            content: "⚠️ Vui lòng chọn cả điểm đi và điểm đến trước khi xác nhận!",
            ephemeral: true,
          });
        }
        originValue = originOpt.value; originLabel = originOpt.label;
        destValue = destOpt.value; destLabel = destOpt.label;
      }

      if (!originValue || !destValue) {
        return interaction.followUp({
          content: "⚠️ Vui lòng chọn cả điểm đi và điểm đến trước khi xác nhận!",
          ephemeral: true,
        });
      }

      const intent = interaction.customId.replace("confirm_route_", "");
      await interaction.editReply({
        content: `⏳ Đang xử lý lộ trình từ **${originLabel}** đến **${destLabel}**...`,
        components: [],
      });

      try {
        const [start, end] = await Promise.all([
          resolveLocationValue(originValue),
          resolveLocationValue(destValue),
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
        for (const [i, chunk] of chunks.entries()) {
          if (i === 0) await interaction.editReply({ content: chunk });
          else await interaction.followUp({ content: chunk });
        }

        // Dọn session sau khi hoàn tất
        sessions.delete(interaction.message.id);
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