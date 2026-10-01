// Модульный Web Worker: грузит bot.js и отвечает на init/tick, как в турнире.
let bot = null;
self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'load') {
    try {
      const mod = await import(m.url);
      bot = mod.default;
      self.postMessage({ type: 'loaded', name: bot.name, stats: bot.stats });
    } catch (err) { self.postMessage({ type: 'error', error: String(err?.stack || err) }); }
  } else if (m.type === 'init') {
    try { bot.init?.(m.info); } catch (err) { /* как в турнире */ }
    self.postMessage({ type: 'inited' });
  } else if (m.type === 'tick') {
    const t0 = performance.now();
    let act = null;
    try { act = bot.tick(m.state); } catch (err) { act = null; }
    const dt = performance.now() - t0;
    self.postMessage({ type: 'act', act, dt });
  }
};
