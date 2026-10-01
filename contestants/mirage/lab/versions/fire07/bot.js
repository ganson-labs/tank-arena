import { createBrain } from '../v16/brain.js';
const brain = createBrain({ weights: { FIRE_NEED: 0.7 } });
export default { name: 'fire07', motto: '', stats: { armor: 0, engine: 0, gun: 5, reload: 5 }, init(i) { brain.init(i); }, tick(s) { return brain.tick(s); }, _brain: brain };
