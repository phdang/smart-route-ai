// src/engine.js
// Calculate Congestion Index and scoring

/**
 * CI label based on standard thresholds (referenced from TomTom Traffic Index)
 */
export function ciLabel(ci) {
  if (ci < 1.15) return "🟢 Thông thoáng";
  if (ci < 1.4)  return "🟡 Hơi đông";
  if (ci < 1.7)  return "🟠 Kẹt trung bình";
  return "🔴 Kẹt nặng";
}

/**
 * Composite Score — lower = better.
 *
 * Old formula: eta * (1 + (ci - 1) * 0.7)
 *   → Issue: when ci < 1 (unrealistic but API might return it), negative score is meaningless
 *   → When two routes have very different ETAs, CI weight wasn't strong enough to reverse rank
 *
 * New formula: Multi-factor Weighted Score
 *   score = w_time * norm_eta + w_ci * norm_ci + w_cost * norm_cost
 *
 * → Normalize each dimension to [0,1] then combine using weights:
 *   - Time (70%): most important
 *   - Congestion (20%): penalize high CI even if ETAs are similar
 *   - Cost (10%): consider BOT/Ferry fees
 *
 * When there is only 1 route (no basis to normalize) → use simple raw score.
 */

const W_TIME = 0.70;
const W_CI   = 0.20;
const W_COST = 0.10;

// Raw score (used when there's no group for comparison — always > 0)
export function score(route) {
  const ciPenalty = Math.max(0, route.ci - 1); // CI penalty >= 0
  return route.eta * (1 + ciPenalty * 0.8);
}

/**
 * Normalize and calculate composite score for a group of routes.
 * Returns an array of routes supplemented with a `.compositeScore` field (lower = better).
 */
export function scoreGroup(routes) {
  if (routes.length === 0) return routes;
  if (routes.length === 1) {
    routes[0].compositeScore = score(routes[0]);
    return routes;
  }

  const etas  = routes.map((r) => r.eta);
  const cis   = routes.map((r) => r.ci);
  const costs = routes.map((r) => r.totalCost || 0);

  const minEta  = Math.min(...etas),  maxEta  = Math.max(...etas);
  const minCi   = Math.min(...cis),   maxCi   = Math.max(...cis);
  const minCost = Math.min(...costs), maxCost = Math.max(...costs);

  const norm = (val, min, max) =>
    max === min ? 0 : (val - min) / (max - min); // 0 = best in group

  return routes.map((r) => ({
    ...r,
    compositeScore:
      W_TIME * norm(r.eta, minEta, maxEta) +
      W_CI   * norm(r.ci,  minCi,  maxCi)  +
      W_COST * norm(r.totalCost || 0, minCost, maxCost),
  }));
}

/**
 * Returns recommended route between highway and alt.
 */
export function recommend(highway, alt) {
  return score(highway) <= score(alt) ? "highway" : "alt";
}
