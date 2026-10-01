// A keyboard-and-mouse "bot": same interface as BotHost, so the match loop
// does not know whether a tank is driven by a worker or by a person.
//   W/S or ↑/↓ — throttle, A/D or ←/→ — hull turn,
//   mouse — turret aim, left button or Space — fire, Q/E — turret without a mouse.
import { normalizeAngle } from '/kit/arena/engine.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class HumanHost {
  constructor(entry, renderer) {
    this.entry = entry;
    this.renderer = renderer;
    this.keys = new Set();
    this.mouse = null;
    this.mouseDown = false;
    this.errors = 0;
    this.missed = 0;
    this.frozen = false;
    this.lastError = '';
    this.onKey = (e) => {
      if (e.target.closest?.('#menu')) return;
      const k = e.key.toLowerCase();
      if (e.type === 'keydown') this.keys.add(k);
      else this.keys.delete(k);
      if (k === ' ' || k.startsWith('arrow')) e.preventDefault();
    };
    this.onMove = (e) => {
      this.mouse = { x: e.clientX, y: e.clientY };
    };
    this.onButton = (e) => {
      if (e.button !== 0 || e.target.closest?.('#menu')) return;
      this.mouseDown = e.type === 'mousedown';
    };
    this.onBlur = () => {
      this.keys.clear();
      this.mouseDown = false;
    };
  }

  async load() {
    addEventListener('keydown', this.onKey);
    addEventListener('keyup', this.onKey);
    addEventListener('mousemove', this.onMove);
    addEventListener('mousedown', this.onButton);
    addEventListener('mouseup', this.onButton);
    addEventListener('blur', this.onBlur);
    return { name: this.entry.name, motto: this.entry.motto, stats: { ...this.entry.stats }, hasTick: true };
  }

  async init() {
    this.keys.clear();
    this.mouseDown = false;
  }

  pressed(...names) {
    return names.some((n) => this.keys.has(n));
  }

  tick(view) {
    const me = view.me;
    const throttle = (this.pressed('w', 'arrowup', 'ц') ? 1 : 0) - (this.pressed('s', 'arrowdown', 'ы') ? 1 : 0);
    const turn = (this.pressed('d', 'arrowright', 'в') ? 1 : 0) - (this.pressed('a', 'arrowleft', 'ф') ? 1 : 0);
    let turretTurn = (this.pressed('e', 'у') ? 1 : 0) - (this.pressed('q', 'й') ? 1 : 0);
    if (!turretTurn && this.mouse) {
      const p = this.renderer.toWorld(this.mouse.x, this.mouse.y);
      const want = Math.atan2(p.y - me.y, p.x - me.x);
      turretTurn = clamp(normalizeAngle(want - me.turret) / (me.stats.turretRate * view.dt), -1, 1);
    }
    return { throttle, turn, turretTurn, fire: this.mouseDown || this.pressed(' ') };
  }

  dispose() {
    removeEventListener('keydown', this.onKey);
    removeEventListener('keyup', this.onKey);
    removeEventListener('mousemove', this.onMove);
    removeEventListener('mousedown', this.onButton);
    removeEventListener('mouseup', this.onButton);
    removeEventListener('blur', this.onBlur);
  }
}
