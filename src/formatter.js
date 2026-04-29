// src/formatter.js
// Beautifully format Discord replies

import { ciLabel } from "./engine.js";

function formatCost(route) {
  let extraInfo = "";
  
  if (route.tollsDetail && route.tollsDetail.length > 0) {
    const tollParts = route.tollsDetail.map(t => {
      const amt = t.price || 0;
      const addr = t.address ? ` - ${t.address}` : "";
      if (t.type === "entry") return `> 🎫 **${t.name}**${addr} *(Vào)*`;
      if (t.type === "exit") return `> 🎫 **${t.name}**${addr} *(${amt.toLocaleString("vi-VN")}đ)*`;
      if (amt > 0) return `> 🎫 **${t.name}**${addr} *(${amt.toLocaleString("vi-VN")}đ)*`;
      return `> 🎫 **${t.name}**${addr}`;
    });
    extraInfo += `\n**Danh sách trạm BOT:**\n${tollParts.join("\n")}`;
  } else if (route.tollsCount) {
    extraInfo += `\n**Danh sách trạm BOT:**\n> 🎫 ${route.tollsCount} trạm BOT`;
  }
  
  if (route.ferriesCount) {
    extraInfo += `\n**Phà:**\n> ⛴️ ${route.ferriesCount} phà`;
  }

  const totalCost = route.totalCost || 0;
  if (totalCost === 0 && !extraInfo) return " | 💰 Phí: **Miễn phí**";

  const costStr = totalCost > 0 ? `~${totalCost.toLocaleString("vi-VN")}đ` : "Miễn phí";
  return ` | 💰 Phí (xe con): **${costStr}**${extraInfo}`;
}

// ─── !route ───────────────────────────────────────────────────────────────
export function formatReply({ highway, alt, recommended }, { origin, dest }) {
  const recName = recommended === "highway" ? "Cao tốc" : "Né cao tốc";
  const saved = Math.abs(highway.eta - alt.eta);
  const savedText =
    saved > 0 ? `— tiết kiệm **${saved} phút**` : "— thời gian tương đương";

  return `
🗺️ **${origin} → ${dest}**

路️ **Cao tốc** *(${highway.summary || "—"})*
> ⏱ \`${highway.eta}\` phút | 📏 ${highway.distance} | ${ciLabel(highway.ci)}${formatCost(highway)}

🏘️ **Né cao tốc** *(${alt.summary || "—"})*
> ⏱ \`${alt.eta}\` phút | 📏 ${alt.distance} | ${ciLabel(alt.ci)}${formatCost(alt)}

✅ **Khuyến nghị: ${recName}** ${savedText}
`.trim();
}

// ─── !check ───────────────────────────────────────────────────────────────
export function formatCheckReply({ primary, best, alternates, llmAnalysis }, { origin, dest }) {
  const isJammed = primary.ci >= 1.5;
  const statusLine = isJammed
    ? `🚨 **Có kẹt xe!** ${ciLabel(primary.ci)} *(CI: ${primary.ci})*`
    : `✅ **Không kẹt xe.** ${ciLabel(primary.ci)} *(CI: ${primary.ci})*`;

  // Main road segments (top 40 longest steps, ordered chronologically A->B)
  const topSegments = [...primary.segments]
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 40)
    .sort((a, b) => a.index - b.index);

  const segmentLines = topSegments.length
    ? topSegments
        .map((s) => `> • **${s.instruction}** — ${s.duration} phút (${s.distance})`)
        .join("\n")
    : "> *(Không có dữ liệu chi tiết)*";

  // Alternative routes section (Only shown if jammed CI >= 1.5)
  let altSection = "";
  if (isJammed) {
    const altLines = alternates.length
      ? alternates
          .map((r, i) => {
            const diff = primary.eta - r.eta;
            const diffText =
              diff > 0
                ? `✅ tiết kiệm **${diff} phút**`
                : diff < 0
                ? `⚠️ chậm hơn ${Math.abs(diff)} phút`
                : "⏱ tương đương";
            
            const isLlmBest = r.is_llm_recommended ? "👑 " : "";
            return `${isLlmBest}${i + 1}️⃣ **${r.summary || "Đường khác"}** — ⏱ \`${r.eta}\` phút | 📏 ${r.distance} | ${ciLabel(r.ci)} — ${diffText}${formatCost(r)}`;
          })
          .join("\n")
      : "*(Không tìm thấy lộ trình thay thế)*";

    let llmText = "";
    if (llmAnalysis) {
      llmText = `\n\n🧠 **Phân tích chiến lược (DeepSeek AI):**\n> ${llmAnalysis}`;
    }
    altSection = `\n\n🗺️ **Lộ trình thay thế:**\n${altLines}${llmText}`;
  }

  return `
🔍 **Kiểm tra kẹt xe: ${origin} → ${dest}**

${statusLine}
⏱ Tuyến chính *(${primary.summary})*: **${primary.eta} phút** *(bình thường: ${primary.normal} phút)* | 📏 ${primary.distance}${formatCost(primary)}
🛡️ **Quy định:** ${primary.regulationStatus}${primary.regulationWarning ? `\n> ${primary.regulationWarning}` : ""}

🚧 **Đoạn đường chính trên tuyến:**
${segmentLines}${altSection}
`.trim();
}

// ─── !traffic ─────────────────────────────────────────────────────────────
export function formatTrafficReply(route, origin) {
  const trafficNote = route.hasTrafficData === false
    ? "\n⚠️ *Dữ liệu ước tính (không có traffic thực — API Billing chưa bật)*"
    : "";

  return `
📍 **Tình trạng giao thông từ ${origin}**

${ciLabel(route.ci)} | CI: \`${route.ci}\`
⏱ Ước tính: **${route.eta} phút** *(bình thường: ${route.normal} phút)* | 📏 ${route.distance}${trafficNote}
`.trim();
}
