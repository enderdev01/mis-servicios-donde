import { createApp } from './app.js';
import { createRequestContext } from './context.js';
import type { Env } from './env.js';

export { ReportLimiter } from './security/report-limiter.js';
export { Scheduler } from './scheduler/scheduler.js';

const app = createApp(createRequestContext);
let schedulerArmed = false;

async function armScheduler(env: Env): Promise<void> {
  await env.SCHEDULER.get(env.SCHEDULER.idFromName('main')).ensure();
}

export default {
  fetch(request, env, ctx) {
    if (!schedulerArmed) {
      schedulerArmed = true;
      ctx.waitUntil(armScheduler(env).catch(() => { schedulerArmed = false; }));
    }
    return app.fetch(request, env, ctx);
  },
  // Hourly cron: re-arm a missing alarm. It never queries the database, so it cannot wake it.
  async scheduled(_controller, env) {
    await armScheduler(env);
  },
} satisfies ExportedHandler<Env>;
