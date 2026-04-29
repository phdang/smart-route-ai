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
  if (NORTH_KEYWORDS.some((k) => lower.includes(k)))   return TRAFFIC_REFS.north;
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

  // Giữ lại tối đa 600 điểm để đảm bảo mật độ cao (khoảng 500m - 1km mỗi điểm), tránh lỗi map-matching
  const MAX_TOTAL_POINTS = 600;
  const step = Math.ceil(coordinates.length / MAX_TOTAL_POINTS);
  const sampled = coordinates.filter((_, i) => i % step === 0);
  const lastCoord = coordinates[coordinates.length - 1];
  if (JSON.stringify(sampled[sampled.length - 1]) !== JSON.stringify(lastCoord)) {
    sampled.push(lastCoord);
  }

  // Chia nhỏ thành các chunk (mỗi chunk max 140 điểm) để không vượt quá giới hạn 200 của Vietmap
  const CHUNK_SIZE = 140;
  const chunks = [];
  for (let i = 0; i < sampled.length; i += (CHUNK_SIZE - 1)) {
    let chunk = sampled.slice(i, i + CHUNK_SIZE);
    if (chunk.length >= 2) chunks.push(chunk);
  }

  console.log(`[Vietmap Tolls] Splitting ${sampled.length} points into ${chunks.length} chunks`);

  try {
    const chunkPromises = chunks.map(chunk => {
      const url = `https://maps.vietmap.vn/api/route-tolls?api-version=1.1&apikey=${apiKey}&vehicle=1`;
      return fetchWithTimeout(url, 10000, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(chunk)
      }).then(res => res.ok ? res.json() : null).catch(() => null);
    });

    const results = await Promise.all(chunkPromises);
    
    let rawTolls = [];
    results.forEach(res => {
      if (res && res.tolls) {
        rawTolls.push(...res.tolls);
      }
    });

    let finalTolls = [];
    let i = 0;

    while (i < rawTolls.length) {
      const t = rawTolls[i];
      
      // Deduplicate artifacts: if exact same name/address and not an entry, skip it.
      if (finalTolls.length > 0) {
        const lastToll = finalTolls[finalTolls.length - 1];
        if (lastToll.name === t.name && lastToll.address === t.address && t.type !== 'entry') {
          i++;
          continue;
        }
      }

      if (t.type === 'entry') {
        let furthestExitIdx = -1;
        for (let j = rawTolls.length - 1; j > i; j--) {
          const exitCandidate = rawTolls[j];
          if (exitCandidate.type === 'exit' && exitCandidate.prices && exitCandidate.prices[t.id] !== undefined) {
            furthestExitIdx = j;
            break;
          }
        }
        
        if (furthestExitIdx !== -1) {
          const trueExit = rawTolls[furthestExitIdx];
          const actualPrice = trueExit.prices[t.id];
          
          finalTolls.push({...t, price: 0});
          finalTolls.push({...trueExit, price: actualPrice});
          
          i = furthestExitIdx + 1; 
        } else {
          finalTolls.push({...t, price: 0});
          i++;
        }
      } else {
        finalTolls.push(t);
        i++;
      }
    }

    console.log(`[Vietmap Tolls] Found ${finalTolls.length} valid tolls (cleaned from ${rawTolls.length} raw)`);
    return finalTolls; 
  } catch (e) {
    console.warn("[Vietmap Tolls Error]", e.message);
    return null;
  }
}

// ─── Parse route from Mapbox response ─────────────────────────────────────
function parseMapboxRoute(route, normalDuration, vietmapTolls = null) {
  const eta = route.duration; // Seconds
  const normal = normalDuration || route.duration; // Seconds
  const distance = (route.distance / 1000).toFixed(1) + " km";

  const ci = normal > 0 ? +(eta / normal).toFixed(2) : 1.0;

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
    summary: route.legs[0].summary || "Route",
    distance,
    tollsCount: finalTollsCount,
    ferriesCount,
    totalCost: finalTotalCost,
    tollsDetail,
    segments,
    regulationStatus: "Dữ liệu Mapbox" // Default value
  };
}

// ─── Fetch Single Route ──────────────────────────────────────────────────
async function fetchRoute(origin, dest, avoid = "") {
  const key = `route:mb:v7:${origin}|${dest}|${avoid}`;
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

// ─── Douglas-Peucker Simplification ─────────────────────────────────────────
function simplifyGeometry(points, tolerance) {
  if (points.length <= 2) return points;
  let maxDistance = 0;
  let index = 0;
  const end = points.length - 1;

  for (let i = 1; i < end; i++) {
    const d = pointLineDistance(points[i], points[0], points[end]);
    if (d > maxDistance) {
      maxDistance = d;
      index = i;
    }
  }

  if (maxDistance > tolerance) {
    const left = simplifyGeometry(points.slice(0, index + 1), tolerance);
    const right = simplifyGeometry(points.slice(index), tolerance);
    return left.slice(0, left.length - 1).concat(right);
  } else {
    return [points[0], points[end]];
  }
}

function pointLineDistance(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) {
    const px = p[0] - a[0];
    const py = p[1] - a[1];
    return Math.sqrt(px * px + py * py);
  }
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy);
  const tClamped = Math.max(0, Math.min(1, t));
  const closestX = a[0] + tClamped * dx;
  const closestY = a[1] + tClamped * dy;
  const px = p[0] - closestX;
  const py = p[1] - closestY;
  return Math.sqrt(px * px + py * py);
}

// ─── Fetch Alternative Routes ────────────────────────────────────────────
async function fetchAlternatives(origin, dest) {
  const key = `alt:mb:v7:${origin}|${dest}`;
  const cached = await cacheGet(key);
  if (cached) return cached;

  const startCoords = await geocode(origin);
  const endCoords = await geocode(dest);

  const url = `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${startCoords.join(',')};${endCoords.join(',')}?access_token=${MAPBOX_TOKEN}&steps=true&geometries=geojson&overview=full&alternatives=true`;
  
  const res = await fetchWithTimeout(url);
  const data = await res.json();

  if (data.code !== "Ok") throw new Error(`Mapbox API: ${data.code}`);

  const normalUrl = `https://api.mapbox.com/directions/v5/mapbox/driving/${startCoords.join(',')};${endCoords.join(',')}?access_token=${MAPBOX_TOKEN}`;
  const nRes = await fetch(normalUrl);
  const nData = await nRes.json();
  const normalDuration = nData.routes && nData.routes[0] ? nData.routes[0].duration : data.routes[0].duration;

  // Fetch Vietmap tolls for all alternative routes in parallel
  const routesWithTolls = await Promise.all(data.routes.map(async (r) => {
    let vt = null;
    const summary = r.legs[0]?.summary || "Unknown";
    if (r.geometry && r.geometry.coordinates) {
      let coords = r.geometry.coordinates;
      let tolerance = 0.0001; // ~10m
      let simplified = simplifyGeometry(coords, tolerance);
      
      // Tăng dần tolerance cho đến khi điểm <= 150 để thỏa mãn giới hạn API Vietmap
      while (simplified.length > 150 && tolerance < 0.1) {
        tolerance *= 1.5;
        simplified = simplifyGeometry(coords, tolerance);
      }
      
      console.log(`[DP Simplification] ${coords.length} -> ${simplified.length} points (tol: ${tolerance})`);
      vt = await fetchVietmapTolls(simplified);
      console.log(`[Vietmap Tolls] Done for: ${summary}, Found: ${vt?.length || 0}`);
    }
    return parseMapboxRoute(r, normalDuration, vt);
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

  if (primary.ci >= 1.5 && alternates.length > 0) {
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
