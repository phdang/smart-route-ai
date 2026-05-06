// src/bot.js
import "dotenv/config";
import { Client, GatewayIntentBits, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { initRedis } from "./cache.js";
import { getBestRoute, getDetailedCheck, getAreaTraffic, searchLocations, resolveLocationValue } from "./routeService.js";
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
    if (intent === "route" || intent === "check") {
      const originLocations = await searchLocations(parsed.origin);
      const destLocations = await searchLocations(parsed.dest);
      
      if (!originLocations || originLocations.length === 0 || !destLocations || destLocations.length === 0) {
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
          .setLabel(`Xác nhận & Kiểm tra`)
          .setStyle(ButtonStyle.Primary)
      );

      await msg.reply({ 
        content: `Vui lòng xác nhận điểm đi và điểm đến cho lộ trình **${parsed.origin} → ${parsed.dest}**:`,
        components: [row1, row2, row3] 
      });
    } else if (intent === "traffic") {
      const locations = await searchLocations(parsed.origin);
      if (!locations || locations.length === 0) {
        return msg.reply("❌ Không tìm thấy địa điểm nào.");
      }

      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('select_traffic_loc')
          .setPlaceholder('Chọn địa điểm chính xác...')
          .addOptions(locations)
      );

      await msg.reply({ 
        content: `Vui lòng chọn địa điểm cho "${parsed.origin}":`,
        components: [row] 
      });
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
💡 *Cache 5 mins • AI Game Theory triggered automatically when CI ≥ 1.25*
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

// ─── Interaction handler for Select Menus and Buttons ─────────────────────
client.on("interactionCreate", async (interaction) => {
  if (interaction.channelId !== ALLOWED_CHANNEL_ID || interaction.user.id !== ALLOWED_USER_ID) return;

  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === 'select_traffic_loc') {
      await interaction.deferUpdate();
      const value = interaction.values[0];

      const selectedOption = interaction.message.components[0].components[0].options.find(o => o.value === value);
      const locationName = selectedOption ? selectedOption.label : "Địa điểm đã chọn";

      await interaction.editReply({ content: `⏳ Đang kiểm tra giao thông cho: **${locationName}**...`, components: [] });

      try {
        const coords = await resolveLocationValue(value);
        if (!coords) {
          return interaction.editReply({ content: "❌ Không thể lấy tọa độ của địa điểm này." });
        }

        const route = await getAreaTraffic(coords, locationName);
        await interaction.editReply({ content: formatTrafficReply(route, locationName) });
      } catch (e) {
        console.error("[Traffic Select error]", e);
        await interaction.editReply({ content: `⚠️ Lỗi: ${e.message}` });
      }
    } else if (interaction.customId.startsWith('select_origin_') || interaction.customId.startsWith('select_dest_')) {
      const value = interaction.values[0];
      const rowIdx = interaction.customId.startsWith('select_origin_') ? 0 : 1;
      
      const newComponents = [...interaction.message.components];
      const selectMenu = newComponents[rowIdx].components[0];
      
      const updatedSelectMenu = StringSelectMenuBuilder.from(selectMenu);
      updatedSelectMenu.setOptions(
        selectMenu.options.map(opt => ({
          ...opt,
          default: opt.value === value
        }))
      );
      
      newComponents[rowIdx] = new ActionRowBuilder().addComponents(updatedSelectMenu);
      await interaction.update({ components: newComponents });
    }
  } else if (interaction.isButton()) {
    if (!interaction.customId.startsWith('confirm_route_')) return;
    
    const originSelect = interaction.message.components[0].components[0];
    const destSelect = interaction.message.components[1].components[0];
    
    const originSelected = originSelect.options.find(o => o.default);
    const destSelected = destSelect.options.find(o => o.default);
    
    if (!originSelected || !destSelected) {
      return interaction.reply({ content: "⚠️ Vui lòng chọn CẢ điểm đi và điểm đến trước khi xác nhận!", ephemeral: true });
    }
    
    const intent = interaction.customId.replace('confirm_route_', '');
    
    await interaction.update({ content: `⏳ Đang xử lý lộ trình từ **${originSelected.label}** đến **${destSelected.label}**...`, components: [] });
    
    try {
      const originCoords = await resolveLocationValue(originSelected.value);
      const destCoords = await resolveLocationValue(destSelected.value);
      
      const parsedFake = { origin: originSelected.label, dest: destSelected.label };
      
      if (intent === "route") {
        const result = await getBestRoute(originCoords, destCoords);
        const chunks = splitMessage(formatReply(result, parsedFake));
        for (const [i, chunk] of chunks.entries()) {
          if (i === 0) await interaction.editReply({ content: chunk });
          else await interaction.followUp({ content: chunk });
        }
      } else if (intent === "check") {
        const result = await getDetailedCheck(originCoords, destCoords);
        const chunks = splitMessage(formatCheckReply(result, parsedFake));
        for (const [i, chunk] of chunks.entries()) {
          if (i === 0) await interaction.editReply({ content: chunk });
          else await interaction.followUp({ content: chunk });
        }
      }
    } catch (e) {
      console.error("[Route Confirm error]", e);
      await interaction.editReply({ content: `⚠️ Lỗi: ${e.message}` });
    }
  }
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
