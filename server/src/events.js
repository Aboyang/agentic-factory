// Server-Sent Events: the server pushes game events to every open browser.

const clients = new Set();
const listeners = new Set();
let snapshot = () => ({});

/** Observe every emitted event (the manager ledger listens here). Returns an unsubscribe function. */
export function onEmit(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Open SSE streams right now (judge mode treats a connected viewer as activity). */
export const clientCount = () => clients.size;

export function setSnapshot(fn) {
  snapshot = fn;
}

export function sseHandler(req, res) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  clients.add(res);
  write(res, { type: 'state', data: snapshot(), at: Date.now() });
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

export function emit(type, data = {}, incidentId) {
  const evt = { type, incidentId, data, at: Date.now() };
  console.log(`[event] ${type}${incidentId ? ` (${incidentId})` : ''}`);
  for (const res of clients) write(res, evt);
  for (const fn of listeners) {
    try {
      fn(evt);
    } catch (err) {
      console.error(`[event] listener failed on ${type}:`, err);
    }
  }
  return evt;
}

function write(res, evt) {
  res.write(`data: ${JSON.stringify(evt)}\n\n`);
}
