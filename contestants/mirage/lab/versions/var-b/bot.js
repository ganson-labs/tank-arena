// v15c только с проверкой ухода у кандидатов и памятью мест, старые аптечки.
import { createBrain } from '../v15c/brain.js';
const brain = createBrain({ weights: { KIT_NAV: 0 } });
export default { name: 'var-b', motto: '', stats: { armor: 0, engine: 0, gun: 5, reload: 5 }, init(i) { brain.init(i); }, tick(s) { return brain.tick(s); }, _brain: brain };
