// src/routeService.js
// Transition from Google Maps to Mapbox API
// Uses Directions API (driving-traffic) and Geocoding API

import fetch from "node-fetch";
import { cacheGet, cacheSet } from "./cache.js";
import { score, scoreGroup } from "./engine.js";
import { analyzeRoutesWithGameTheory } from "./llmService.js";

const MAPBOX_TOKEN = process.env.MAPBOX_ACCESS_TOKEN;
const API_TIMEOUT_MS = 10000;

// Reference destinations for !traffic command
const TRAFFIC_REFS = {
  north: "Hồ Hoàn Kiếm, Hà Nội",
  south: "Bến Thành, Quận 1, Thành phố Hồ Chí Minh",
  central: "Ngã Năm, Đà Nẵng",
};
const NORTH_KEYWORDS = ["hà nội", "hanoi", "hải phòng", "quảng ninh", "ninh bình",
  "nam định", "thái bình", "bắc", "lạng sơn", "lào cai"];
const CENTRAL_KEYWORDS = ["đà nẵng", "huế", "quảng nam", "quảng ngãi", "bình định", "phú yên"];

export function pickTrafficRef(location) {
  const lower = location.toLowerCase();
  if (NORTH_KEYWORDS.some((k) => lower.includes(k))) return TRAFFIC_REFS.north;
  if (CENTRAL_KEYWORDS.some((k) => lower.includes(k))) return TRAFFIC_REFS.central;
  return TRAFFIC_REFS.south;
}

// ─── Geocoding: Location Name -> [lng, lat] ──────────────────────────────
async function geocode(query) {
  const cacheKey = `geo:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  // Default priority for results near HCMC (106.660172, 10.762622)
  const proximity = "106.660172,10.762622";
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?access_token=${MAPBOX_TOKEN}&limit=1&country=vn&proximity=${proximity}`;

  const res = await fetch(url);
  const data = await res.json();

  if (!data.features || data.features.length === 0) {
    throw new Error(`Coordinates not found for: ${query}`);
  }

  const coords = data.features[0].center; // [lng, lat]
  await cacheSet(cacheKey, coords);
  return coords;
}

// ─── Fetch with Timeout ───────────────────────────────────────────────────
async function fetchWithTimeout(url, timeoutMs = API_TIMEOUT_MS, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Vietmap: Route v3 for Regulation Check ────────────────────────────────
async function fetchVietmapRoute(startCoords, endCoords) {
  const apiKey = process.env.VIETMAP_API_KEY;
  if (!apiKey) return null;

  // Vietmap uses lat,lng
  const url = `https://maps.vietmap.vn/api/route/v3?apikey=${apiKey}&point=${startCoords[1]},${startCoords[0]}&point=${endCoords[1]},${endCoords[0]}&vehicle=car`;

  try {
    const res = await fetchWithTimeout(url, 5000);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.code !== "OK" || !data.paths) return null;

    return {
      distance: (data.paths[0].distance / 1000).toFixed(1) + " km",
      time: Math.round(data.paths[0].time / 1000 / 60), // ms to minutes
      summary: data.paths[0].instructions[0]?.street_name || "Vietmap Route"
    };
  } catch (e) {
    console.warn("[Vietmap Route v3 Error]", e.message);
    return null;
  }
}

// ─── Vietmap: Fetch Toll Details ──────────────────────────────────────────
async function fetchVietmapTolls(coordinates) {
  const apiKey = process.env.VIETMAP_API_KEY;
  if (!apiKey || !coordinates || coordinates.length < 2) return null;

  // Để Vietmap hiểu đây là MỘT chuyến đi liền mạch và tính đúng giá trọn tuyến,
  // chúng ta BẮT BUỘC phải gửi toàn bộ lộ trình trong 1 request duy nhất.
  // Giới hạn của API là 200 điểm, ta dùng 180 điểm để an toàn và dàn đều tọa độ.
  const MAX_POINTS = 180;
  const step = Math.ceil(coordinates.length / MAX_POINTS);
  const sampled = coordinates.filter((_, i) => i % step === 0);
  const lastCoord = coordinates[coordinates.length - 1];
  if (JSON.stringify(sampled[sampled.length - 1]) !== JSON.stringify(lastCoord)) {
    sampled.push(lastCoord);
  }

  console.log(`[Vietmap Tolls] Sending 1 continuous request with ${sampled.length} points to preserve trip continuity`);

  const url = `https://maps.vietmap.vn/api/route-tolls?api-version=1.1&apikey=${apiKey}&vehicle=1`;

  try {
    const res = await fetchWithTimeout(url, 12000, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sampled)
    });

    if (!res.ok) {
      console.warn(`[Vietmap Tolls] HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    let rawTolls = data.tolls || [];

    // ─── Lớp 1: Khử trùng lặp liền kề sơ bộ (Raw Deduplication) ───
    // Dù không dùng chunk, ta vẫn nên khử các trạm bị lặp liên tiếp do lỗi Map-Matching (vd: trạm Km 54+000 xuất hiện 5 lần)
    let uniqueTolls = [];
    rawTolls.forEach(t => {
      if (uniqueTolls.length > 0) {
        const lastToll = uniqueTolls[uniqueTolls.length - 1];
        if (lastToll.name === t.name && lastToll.address === t.address && t.type !== 'entry') {
          return; // Bỏ qua trạm lặp
        }
      }
      uniqueTolls.push(t);
    });

    // ─── Lớp 2: Quét trạm ảo liền kề (Adjacency Cleanup) ───
    let cleanedTolls = [];
    let i = 0;
    while (i < uniqueTolls.length) {
      if (i < uniqueTolls.length - 1) {
        const t1 = uniqueTolls[i];
        const t2 = uniqueTolls[i + 1];
        if (t1.name === t2.name && t1.address === t2.address) {
          const t1IsEntry = t1.type === 'entry';
          const t2IsEntry = t2.type === 'entry';
          const t1IsExitOrPaid = t1.type === 'exit' || (t1.price && t1.price > 0);
          const t2IsExitOrPaid = t2.type === 'exit' || (t2.price && t2.price > 0);

          if ((t1IsExitOrPaid && t2IsEntry) || (t1IsEntry && t2IsExitOrPaid)) {
            console.log(`[Vietmap Tolls] Artifact pair removed: ${t1.name}`);
            i += 2; // Bỏ qua cả hai trạm ảo
            continue;
          }
        }
      }
      cleanedTolls.push(uniqueTolls[i]);
      i++;
    }

    // ─── Lớp 3: Tìm trạm Ra xa nhất (Furthest Exit Chain) ───
    let finalTolls = [];
    i = 0;
    while (i < cleanedTolls.length) {
      const t = cleanedTolls[i];

      let furthestExitIdx = -1;
      // Dò tìm trạm Ra xa nhất kéo dài chuỗi từ trạm hiện tại
      for (let j = cleanedTolls.length - 1; j > i; j--) {
        const exitCandidate = cleanedTolls[j];
        if (exitCandidate.type === 'exit' && exitCandidate.prices && exitCandidate.prices[t.id] !== undefined) {
          furthestExitIdx = j;
          break;
        }
      }

      if (furthestExitIdx !== -1) {
        const trueExit = cleanedTolls[furthestExitIdx];
        const actualPrice = trueExit.prices[t.id];

        // Chỉ thêm t nếu nó chưa được thêm ở cuối chuỗi trước đó
        if (finalTolls.length === 0 || finalTolls[finalTolls.length - 1].id !== t.id) {
          finalTolls.push({ ...t, price: t.type === 'entry' ? 0 : (t.price || 0) });
        }

        finalTolls.push({ ...trueExit, price: actualPrice });

        // Nhảy đến trạm Ra xa nhất để tiếp tục nối chuỗi từ đó
        i = furthestExitIdx;
      } else {
        // Trạm không tìm được cặp (unpaired toll)
        if (finalTolls.length === 0 || finalTolls[finalTolls.length - 1].id !== t.id) {
          finalTolls.push(t);
        }
        i++;
      }
    }

    console.log(`[Vietmap Tolls] Found ${finalTolls.length} valid tolls`);
    return finalTolls;
  } catch (e) {
    console.warn("[Vietmap Tolls Error]", e.message);
    return null;
  }
}

// ─── Free-flow speed assumptions (km/h) ──────────────────────────────────
const FREE_FLOW_SPEED = {
  highway: 100,  // Cao tốc
  national: 80,  // Quốc lộ
  urban: 45,     // Đường đô thị TPHCM (thực tế thấp hơn lý thuyết)
};

/**
 * Detect road type từ summary của Mapbox route.
 * Mapbox trả về summary là tên đường chính của lộ trình.
 */
function detectRoadType(summary = "") {
  const s = summary.toLowerCase();
  if (/cao tốc|ct\s*\.|expressway|a1|hcm.?tl|tphcm.?tl/.test(s)) return "highway";
  if (/quốc lộ|ql\s*\d|national|highway \d/.test(s)) return "national";
  return "urban";
}

function calcFreeFlowCI(durationInTrafficSec, distanceMeters, summary, normalDurationSec) {
  const roadType = detectRoadType(summary);
  const speedKph = FREE_FLOW_SPEED[roadType];
  const theoreticalFreeFlowSec = (distanceMeters / 1000 / speedKph) * 3600;

  // Choose the more realistic baseline: either the theoretical free flow or the historical normal.
  // We use the larger value (slower time) to avoid labeling historical 'normal' traffic as 'congested'.
  const baselineSec = Math.max(theoreticalFreeFlowSec, normalDurationSec || 0);

  return baselineSec > 0 ? +(durationInTrafficSec / baselineSec).toFixed(2) : 1.0;
}


// ─── Parse route from Mapbox response ─────────────────────────────────────
function parseMapboxRoute(route, normalDuration, vietmapTolls = null) {
  const eta = route.duration; // Seconds
  const normal = normalDuration || route.duration; // Seconds
  const distance = route.distance
  const summary = route.legs[0].summary || "Route"

  const ci = calcFreeFlowCI(eta, distance, summary, normal);
  let tollsCount = 0;
  let ferriesCount = 0;

  const TOLL_KEYWORDS = ["thu phí", "toll", "bot"];
  const FERRY_KEYWORDS = ["phà", "ferry", "bắc qua sông"];

  const segments = route.legs[0].steps.map((s, index) => {
    const instruction = s.maneuver.instruction;
    const lower = instruction.toLowerCase();

    if (TOLL_KEYWORDS.some(kw => lower.includes(kw))) tollsCount++;
    if (FERRY_KEYWORDS.some(kw => lower.includes(kw))) ferriesCount++;

    return {
      index,
      instruction,
      duration: Math.round(s.duration / 60),
      distance: (s.distance / 1000).toFixed(1) + " km"
    };
  }).filter(s => s.duration > 0);

  // Toll processing
  let tollsDetail = [];
  let finalTollsCount = 0;
  let finalTotalCost = 0;

  if (vietmapTolls && vietmapTolls.length > 0) {
    // Use precise data from Vietmap
    tollsDetail = vietmapTolls; // Include all stations
    finalTollsCount = tollsDetail.length;
    finalTotalCost = tollsDetail.reduce((sum, t) => sum + (t.price || 0), 0) + (ferriesCount * 15000);
  } else {
    // Fallback to keyword-based estimation
    finalTollsCount = tollsCount;
    finalTotalCost = (tollsCount * 35000) + (ferriesCount * 15000);
  }

  return {
    eta: Math.round(eta / 60),
    normal: Math.round(normal / 60),
    ci,
    hasTrafficData: true,
    distance: (distance / 1000).toFixed(1) + " km",
    tollsCount: finalTollsCount,
    ferriesCount,
    totalCost: finalTotalCost,
    tollsDetail,
    segments,
    summary,
    regulationStatus: "Dữ liệu Mapbox" // Default value
  };
}

// ─── Fetch Single Route ──────────────────────────────────────────────────
async function fetchRoute(origin, dest, avoid = "") {
  const key = `route:mb:v10:${origin}|${dest}|${avoid}`;
  const cached = await cacheGet(key);
  if (cached) return cached;

  const startCoords = await geocode(origin);
  const endCoords = await geocode(dest);

  const exclude = avoid === "highways" ? "&exclude=motorway" : "";

  const trafficUrl = `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${startCoords.join(',')};${endCoords.join(',')}?access_token=${MAPBOX_TOKEN}&steps=true&geometries=geojson&overview=full${exclude}`;

  const normalUrl = `https://api.mapbox.com/directions/v5/mapbox/driving/${startCoords.join(',')};${endCoords.join(',')}?access_token=${MAPBOX_TOKEN}${exclude}`;

  const [tRes, nRes] = await Promise.all([
    fetchWithTimeout(trafficUrl),
    fetchWithTimeout(normalUrl)
  ]);

  const tData = await tRes.json();
  const nData = await nRes.json();

  if (tData.code !== "Ok") throw new Error(`Mapbox API: ${tData.code} - ${tData.message}`);

  const route = tData.routes[0];
  const normalDuration = nData.routes && nData.routes[0] ? nData.routes[0].duration : route.duration;

  // Parallel checks: Tolls + Regulations (Vietmap v3)
  const [vietmapTolls, vietmapRegs] = await Promise.all([
    route.geometry && route.geometry.coordinates ? fetchVietmapTolls(route.geometry.coordinates) : null,
    fetchVietmapRoute(startCoords, endCoords)
  ]);

  const result = parseMapboxRoute(route, normalDuration, vietmapTolls);

  // Add regulation status
  result.regulationStatus = "Dữ liệu Mapbox";
  if (vietmapRegs) {
    // If Vietmap distance is significantly longer than Mapbox, Mapbox might be taking a restricted road
    const mbDist = parseFloat(result.distance);
    const vmDist = parseFloat(vietmapRegs.distance);
    if (vmDist > mbDist + 1.5) { // 1.5km threshold
      result.regulationWarning = "⚠️ Mapbox có thể đang chỉ đường vào đoạn đường hạn chế/cấm ô tô. Hãy cân nhắc lộ trình từ Vietmap.";
    } else {
      result.regulationStatus = "✅ Đã kiểm tra biển cấm (Vietmap)";
    }
  }

  await cacheSet(key, result);
  return result;
}

// ─── Fetch Alternative Routes ────────────────────────────────────────────
async function fetchAlternatives(origin, dest) {
  const key = `alt:mb:v10:${origin}|${dest}`;
  const cached = await cacheGet(key);
  if (cached) return cached;

  const startCoords = await geocode(origin);
  const endCoords = await geocode(dest);

  const url = `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${startCoords.join(',')};${endCoords.join(',')}?access_token=${MAPBOX_TOKEN}&steps=true&geometries=geojson&overview=full&alternatives=true`;

  const res = await fetchWithTimeout(url);
  const data = await res.json();

  if (data.code !== "Ok") throw new Error(`Mapbox API: ${data.code}`);

  const normalUrl = `https://api.mapbox.com/directions/v5/mapbox/driving/${startCoords.join(',')};${endCoords.join(',')}?access_token=${MAPBOX_TOKEN}&alternatives=true`;
  const nRes = await fetch(normalUrl);
  const nData = await nRes.json();
  const normalDuration = nData.routes && nData.routes[0] ? nData.routes[0].duration : data.routes[0].duration;

  // Fetch Vietmap tolls for all alternative routes in parallel
  const routesWithTolls = await Promise.all(data.routes.map(async (r, idx) => {
    let vt = null;
    const summary = r.legs[0]?.summary || "Unknown";
    if (r.geometry && r.geometry.coordinates) {
      let coords = r.geometry.coordinates;
      vt = await fetchVietmapTolls(coords);
      console.log(`[Vietmap Tolls] Done for: ${summary}, Found: ${vt?.length || 0}`);
    }
    
    // Match normal duration by index if possible, fallback to first route's normal
    const nRoute = nData.routes && nData.routes[idx] ? nData.routes[idx] : nData.routes[0];
    const nDuration = nRoute ? nRoute.duration : r.duration;

    return parseMapboxRoute(r, nDuration, vt);
  }));

  // Add regulation check for the primary alternative
  const vietmapRegs = await fetchVietmapRoute(startCoords, endCoords);
  if (vietmapRegs && routesWithTolls[0]) {
    const mbDist = parseFloat(routesWithTolls[0].distance);
    const vmDist = parseFloat(vietmapRegs.distance);
    if (vmDist > mbDist + 1.5) {
      routesWithTolls[0].regulationWarning = "⚠️ Mapbox có thể đang chỉ đường vào đoạn đường hạn chế/cấm ô tô. Hãy cân nhắc lộ trình từ Vietmap.";
    } else {
      routesWithTolls[0].regulationStatus = "✅ Đã kiểm tra biển cấm (Vietmap)";
    }
  }

  await cacheSet(key, routesWithTolls);
  return routesWithTolls;
}

// ─── Public Functions ────────────────────────────────────────────────────
export async function getBestRoute(origin, dest) {
  const [highway, alt] = await Promise.all([
    fetchRoute(origin, dest),
    fetchRoute(origin, dest, "highways"),
  ]);
  const recommended = score(highway) <= score(alt) ? "highway" : "alt";
  return { highway, alt, recommended };
}

export async function getAreaTraffic(location) {
  const refDest = pickTrafficRef(location);
  const isDowntown = location.toLowerCase().includes("bến thành") ||
    location.toLowerCase().includes("quận 1") ||
    location.toLowerCase().includes("trung tâm");

  const dest = isDowntown ? TRAFFIC_REFS.north : refDest;
  return await fetchRoute(location, dest);
}

export async function getDetailedCheck(origin, dest) {
  const [alternatives, avoidHighway] = await Promise.all([
    fetchAlternatives(origin, dest),
    fetchRoute(origin, dest, "highways"),
  ]);

  const primary = alternatives[0];
  console.log(`[Check Result] Primary: ${primary.summary}, tolls: ${primary.tollsCount}, cost: ${primary.totalCost}`);

  const allRoutes = [...alternatives];
  if (!allRoutes.some(r => r.summary === avoidHighway.summary)) {
    allRoutes.push(avoidHighway);
  }

  const ranked = scoreGroup(allRoutes).sort((a, b) => a.compositeScore - b.compositeScore);
  const alternates = ranked.filter(r => r.summary !== primary.summary);

  let best = alternates[0] ?? null;
  let llmAnalysis = null;

  if (primary.ci >= 1.35 && alternates.length > 0) {
    const analysisResult = await analyzeRoutesWithGameTheory(primary, alternates);
    if (analysisResult) {
      llmAnalysis = analysisResult.game_theory_analysis;
      const idx = Number(analysisResult.best_alternative_id);
      if (Number.isInteger(idx) && alternates[idx]) {
        best = { ...alternates[idx], is_llm_recommended: true };
      }
    }
  }

  return { primary, best, alternates, llmAnalysis };
}
