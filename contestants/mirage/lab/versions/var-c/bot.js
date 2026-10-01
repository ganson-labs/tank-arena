// v15c только с новыми аптечками (без проверки ухода у кандидатов и памяти мест).
import { createBrain } from '../v15c/brain.js';
const brain = createBrain({ weights: { GOAL_ESC: 0, HITSPOT: 0 } });
export default { name: 'var-c', motto: '', stats: { armor: 0, engine: 0, gun: 5, reload: 5 }, init(i) { brain.init(i); }, tick(s) { return brain.tick(s); }, _brain: brain };
