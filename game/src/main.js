// Wiring: 3D world + DOM overlay + director, fed by the server's event stream.

import './ui/ui.css';
import './ui/ui-shell.css';
import './ui/ui-agent.css';
import { MACHINES } from '../../shared/contract.js';
import { UI } from './ui/UI.js';
import { Director } from './director.js';
import { api, connectEvents } from './net.js';

const worldEl = document.getElementById('world');

// The panels and the agent flow must keep working even if the 3D world can't
// start (no WebGL, or a broken world module): fall back to a no-op world.
async function createWorld() {
  try {
    const { World } = await import('./world/World.js');
    const world = new World(worldEl);
    world.setMachines?.(MACHINES);
    return world;
  } catch (err) {
    console.error('[main] 3D world failed to start', err);
    worldEl.innerHTML = '<div class="world-fallback">3D view unavailable.<br>The plant, the agent and every panel still work.</div>';
    // Every World method is a no-op ('then' stays undefined so this isn't mistaken for a promise).
    return new Proxy({}, { get: (_, key) => (key === 'then' ? undefined : () => null) });
  }
}

// The server ticks every second, even while paused. If nothing arrives for this
// long the stream is dead without an error event (e.g. the dev proxy kept the
// browser side open after a server restart): drop it and reconnect. The server
// sends a full STATE on every new connection.
const STALE_MS = 8000;
// A tab hidden this long lets its stream go (see connectLive).
const HIDDEN_CLOSE_MS = 20000;

/**
 * Keep the live event stream open while the page is in use. A tab that stays
 * hidden closes its stream: the browser allows only ~6 connections per host,
 * and a few idle tabs each holding an EventSource would starve the next fetch
 * (a scenario START that never lands). Showing the tab again, or any click or
 * key press, reconnects; the server then sends a full STATE.
 */
function connectLive(director, ui) {
  let es = null;
  let last = 0;
  let everOpen = false;
  let hideTimer = 0;
  let trustHidden = true; // false once we see input while "hidden" (embedded views can misreport)
  const open = () => {
    clearTimeout(hideTimer);
    if (es) return;
    last = performance.now();
    const src = connectEvents((evt) => {
      last = performance.now();
      director.handle(evt);
    });
    src.addEventListener('open', () => {
      everOpen = true;
      last = performance.now();
      ui.setConnected(true);
    });
    src.addEventListener('error', () => {
      if (everOpen && src === es) ui.setConnected(src.readyState === EventSource.OPEN);
    });
    es = src;
  };
  const close = () => {
    es?.close();
    es = null;
  };
  const scheduleHiddenClose = () => {
    clearTimeout(hideTimer);
    if (trustHidden && document.visibilityState === 'hidden') hideTimer = setTimeout(close, HIDDEN_CLOSE_MS);
  };
  setInterval(() => {
    if (!es || performance.now() - last < STALE_MS) return;
    console.warn('[main] event stream silent, reconnecting');
    if (everOpen) ui.setConnected(false);
    close();
    open();
  }, 2000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') scheduleHiddenClose();
    else open();
  });
  const wake = () => {
    if (document.visibilityState === 'hidden') trustHidden = false;
    open();
  };
  window.addEventListener('pointerdown', wake, true);
  window.addEventListener('keydown', wake, true);
  open();
  scheduleHiddenClose();
}

async function start() {
  const world = await createWorld();
  const ui = new UI(document.getElementById('ui'), { world, api });
  const director = new Director(world, ui, { api });

  // The world canvas sizes itself on window resize; forward container size changes too.
  if ('ResizeObserver' in window) {
    let raf = 0;
    new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    }).observe(worldEl);
  }

  director.boot();
  connectLive(director, ui);

  // Handy in the browser console while developing.
  Object.assign(window, { world, ui, director });
}

start();
