import cron from 'node-cron';
import { loadConfig } from './config.js';
import { runImport } from './importer.js';
import { logger } from './logger.js';

async function preflight(): Promise<void> {
  logger.info('Running pre-flight checks…');

  // Validate Node version
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && (minor ?? 0) < 12)) {
    throw new Error(
      `Node >= 22.12 required for israeli-bank-scrapers. Got: ${process.version}`,
    );
  }

  // Validate timezone
  const tz = process.env['TZ'];
  if (tz !== 'Asia/Jerusalem') {
    logger.warn(
      `TZ is "${tz ?? 'unset'}" — expected "Asia/Jerusalem". ` +
        'Bank date parsing may be incorrect.',
    );
  }

  logger.info('Loading and validating config…');
  const config = loadConfig();
  logger.info(
    `Config loaded — ${Object.keys(config.banks).length} bank(s) configured`,
  );

  return;
}

async function main(): Promise<void> {
  logger.info('Israeli Banks → Sure Finance Importer starting…');

  await preflight();

  const schedule = process.env['SCHEDULE'];

  if (!schedule) {
    // One-shot mode
    logger.info('No SCHEDULE set — running once and exiting');
    const config = loadConfig();
    await runImport(config);
    logger.info('Done.');
    return;
  }

  // Validate the cron expression before registering
  if (!cron.validate(schedule)) {
    throw new Error(`SCHEDULE "${schedule}" is not a valid cron expression`);
  }

  logger.info(`Scheduling with cron: "${schedule}" (TZ=Asia/Jerusalem)`);

  // Run immediately on startup, then on schedule
  async function tick(): Promise<void> {
    logger.info('Cron tick — starting import…');
    try {
      const config = loadConfig(); // reload each run so config changes take effect
      await runImport(config);
    } catch (err) {
      logger.error(`Import run failed: ${(err as Error).message}`);
      // Do not exit — keep the scheduler alive for the next run
    }
  }

  await tick();

  cron.schedule(schedule, tick, { timezone: 'Asia/Jerusalem' });
  logger.info('Scheduler running — press Ctrl+C to stop');
}

main().catch((err) => {
  logger.error(`Fatal: ${(err as Error).message}`);
  if (process.env['LOG_LEVEL'] === 'debug' && err instanceof Error && err.stack) {
    logger.debug(err.stack);
  }
  process.exit(1);
});
