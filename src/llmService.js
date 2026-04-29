// src/llmService.js
// Communication with OpenRouter API using DeepSeek LLM for Game Theory route analysis

import fetch from "node-fetch";

const MODEL       = "deepseek/deepseek-v4-flash";
const LLM_TIMEOUT = 15000; // 15 seconds timeout

// ─── Helpers ──────────────────────────────────────────────────────────────
function formatCostText(r) {
  if (!r.totalCost) return "Free";
  return `~${r.totalCost.toLocaleString("vi-VN")}đ (${r.tollsCount || 0} BOT, ${r.ferriesCount || 0} Ferries)`;
}

function buildPrompt(primary, alternates) {
  return `You are an AI expert in Game Theory and traffic coordination in Vietnam.
The main route is currently congested. Please choose the optimal alternative route by performing a multi-dimensional analysis.

[MAIN ROUTE - CONGESTED]
- Name: ${primary.summary || "Main Road"}
- Real-time duration: ${primary.eta} mins (typical: ${primary.normal} mins)
- Congestion Index (CI): ${primary.ci}
- Cost (car): ${formatCostText(primary)}

[AVAILABLE ALTERNATIVES]
${alternates
  .map(
    (r, i) => `[ID:${i}] ${r.summary || "Unnamed"}
  ETA: ${r.eta} mins | CI: ${r.ci} | Cost: ${formatCostText(r)}`
  )
  .join("\n")}

Analysis Requirements:
1. Apply Minimax Regret strategy: Choose the route with the lowest worst-case regret.
2. Consider Nash Equilibrium: Avoid routes where many drivers might flock (typically famous parallel roads).
3. Consider financial costs as a component in the Payoff Matrix.

Language Rule:
- If the input was in Vietnamese (or about Vietnam locations), provide "game_theory_analysis" in Vietnamese.
- If the input was in English or another language, respond in that language.
- DEFAULT: Vietnamese.

Return RAW JSON only — no markdown, no extra text:
{"best_alternative_id":<integer 0-${alternates.length - 1}>,"game_theory_analysis":"<2-3 sentences analysis in appropriate language>"}`;
}

// ─── Main Export: Route Analysis ─────────────────────────────────────────
export async function analyzeRoutesWithGameTheory(primary, alternates) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.warn("[LLM] OPENROUTER_API_KEY not configured — skipping AI analysis");
    return null;
  }
  if (alternates.length === 0) return null;

  const prompt = buildPrompt(primary, alternates);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT);

  try {
    console.log("[LLM] Calling OpenRouter Game Theory...");
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method:  "POST",
      signal:  controller.signal,
      headers: {
        Authorization:  `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer":  "https://github.com/phdang/smart-route-ai",
        "X-Title":       "Smart Route AI",
      },
      body: JSON.stringify({
        model:           MODEL,
        messages:        [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        temperature:     0.1,
        max_tokens:      256,
      }),
    });

    clearTimeout(timer);

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.warn(`[LLM] API Error ${res.status}: ${errBody.slice(0, 200)}`);
      return null;
    }

    const data    = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      console.warn("[LLM] Empty response from API");
      return null;
    }

    // Sanitize: Strip markdown code fences
    const cleaned = content.replace(/```(?:json)?|```/g, "").trim();
    const parsed  = JSON.parse(cleaned);

    // Validate schema
    if (
      typeof parsed.best_alternative_id !== "number" ||
      typeof parsed.game_theory_analysis !== "string"
    ) {
      console.warn("[LLM] Invalid response schema:", parsed);
      return null;
    }

    return parsed;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      console.warn("[LLM] Timeout after", LLM_TIMEOUT, "ms — skipping AI");
    } else {
      console.error("[LLM Error]", err.message);
    }
    return null;
  }
}

/**
 * Use AI to parse natural language commands (NLP)
 */
export async function parseCommandWithAI(text) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  const prompt = `
You are a virtual assistant parsing intents for a traffic bot.
Analyze the following command and return JSON.

Command: "${text}"

Intents:
- "route": Compare 2 routes (usually contains "to", "from", "go", "→").
- "check": Detailed traffic check (usually contains "to", "from", "go", "→").
- "traffic": Check status of 1 location.
- "help": Request help.

JSON Requirements:
{
  "intent": "route" | "check" | "traffic" | "help" | "unknown",
  "origin": "origin point or main location",
  "destination": "destination point (if any)"
}

Example: 
"!check Nguyễn Thị Tú to Bến Thành" -> {"intent": "check", "origin": "Nguyễn Thị Tú Bình Tân TPHCM", "destination": "Metro Bến Thành TPHCM"}

Important: Keep the "origin" and "destination" in the same language as the input text.

Return RAW JSON only (no markdown):`;

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        temperature: 0,
      }),
    });

    if (!res.ok) return null;
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    return JSON.parse(content.replace(/```(?:json)?|```/g, "").trim());
  } catch (e) {
    console.error("[LLM Parser Error]", e.message);
    return null;
  }
}
