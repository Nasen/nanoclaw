/**
 * Setup CLI entry point.
 * Usage: npx tsx setup/index.ts --step <name> [args...]
 */
import { logger } from '../src/logger.js';
import { emitStatus } from './status.js';
import { formatSetupUsage, getSetupStep } from './steps.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (
    args.includes('--help') ||
    args.includes('-h') ||
    args.includes('--list')
  ) {
    console.error(formatSetupUsage());
    process.exit(0);
  }

  const stepIdx = args.indexOf('--step');

  if (stepIdx === -1 || !args[stepIdx + 1]) {
    console.error(formatSetupUsage());
    process.exit(1);
  }

  const stepName = args[stepIdx + 1];
  const stepArgs = args.filter(
    (a, i) => i !== stepIdx && i !== stepIdx + 1 && a !== '--',
  );

  const step = getSetupStep(stepName);
  if (!step) {
    console.error(`Unknown step: ${stepName}`);
    console.error(formatSetupUsage());
    process.exit(1);
  }

  try {
    const mod = await step.load();
    await mod.run(stepArgs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, step: stepName }, 'Setup step failed');
    emitStatus(stepName.toUpperCase(), {
      STATUS: 'failed',
      ERROR: message,
    });
    process.exit(1);
  }
}

main();
