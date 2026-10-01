// Лабораторный вариант для калибровки порога выстрела: стреляет при покрытии ≥ 0.5 и пишет журнал.
import { createBrain } from '../../../tank/brain.js';
const brain = createBrain({ weights: { FIRE_NEED: 0.5 } });
export default {
  name: 'Мираж-калибр', motto: 'калибровка', stats: { armor: 0, engine: 0, gun: 5, reload: 5 },
  init(info) { brain.init(info); }, tick(s) { return brain.tick(s); }, _brain: brain,
};
