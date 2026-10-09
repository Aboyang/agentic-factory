// Talking to the server. Shared by everyone on the game side.

export async function api(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

/** Subscribe to server events. handler(evt) gets { type, incidentId, data, at }. */
export function connectEvents(handler) {
  const es = new EventSource('/api/events');
  es.onmessage = (m) => handler(JSON.parse(m.data));
  es.onerror = () => console.warn('[events] connection lost, retrying…');
  return es;
}
