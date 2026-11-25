// localStorage wrapper; falls back to memory silently when storage is unavailable.

const PREFIX = 'orbit:';
const memory = new Map();

export function load(key, fallback = null) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw !== null) return JSON.parse(raw);
  } catch {
    // ignore, use memory
  }
  return memory.has(key) ? memory.get(key) : fallback;
}

export function save(key, value) {
  memory.set(key, value);
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // quota or privacy mode: memory copy is enough
  }
}

// Short stable hash for song ids
export function hashBytes(bytes, extra = '') {
  let h = 0x811c9dc5;
  const step = Math.max(1, Math.floor(bytes.length / 65536));
  for (let i = 0; i < bytes.length; i += step) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(36)}-${bytes.length.toString(36)}${extra}`;
}
