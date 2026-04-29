// src/parser.js
// Parse origin/destination from Discord messages

// Maximum allowed input length (against fuzzing/injection)
const MAX_INPUT_LEN = 150;

function sanitize(str) {
  return str
    .trim()
    .slice(0, MAX_INPUT_LEN)       // Limit length
    .replace(/[<>{}[\]`]/g, "");   // Remove special characters that could cause injection
}

/**
 * !route [origin] → [destination]
 * Supported separators: →  ->  |  ;
 */
export function parseRouteCommand(text) {
  const match = text.match(/^!route\s+(.+?)\s*(?:→|->|\||;)\s*(.+)/i);
  if (!match) return null;
  return { origin: sanitize(match[1]), dest: sanitize(match[2]) };
}

/**
 * !check [origin] → [destination]
 * Checks for congestion, bottlenecks, and alternative routes using AI
 */
export function parseCheckCommand(text) {
  const match = text.match(/^!check\s+(.+?)\s*(?:→|->|\||;)\s*(.+)/i);
  if (!match) return null;
  return { origin: sanitize(match[1]), dest: sanitize(match[2]) };
}

/**
 * !traffic [location]
 * Quick report on traffic status at a specific area
 */
export function parseTrafficCommand(text) {
  const match = text.match(/^!traffic\s+(.+)/i);
  if (!match) return null;
  return { origin: sanitize(match[1]) };
}
