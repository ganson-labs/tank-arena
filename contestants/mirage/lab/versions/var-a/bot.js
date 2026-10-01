// v15c без проверки ухода у кандидатов в цель и без памяти мест (≈ v14b + кэш рикошетов), старые аптечки.
import { createBrain } from '../v15c/brain.js';
const brain = createBrain({ weights: { GOAL_ESC: 0, HITSPOT: 0, KIT_NAV: 0 } });
export default { name: 'var-a', motto: '', stats: { armor: 0, engine: 0, gun: 5, reload: 5 }, init(i) { brain.init(i); }, tick(s) { return brain.tick(s); }, _brain: brain };
