import { logger } from './logger.js';
import {
  _setRegisteredGroups,
  getAvailableGroups,
  startNanoClaw,
} from './bootstrap/start-app.js';

export { escapeXml, formatMessages } from './router.js';
export { _setRegisteredGroups, getAvailableGroups, startNanoClaw };

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  startNanoClaw().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
