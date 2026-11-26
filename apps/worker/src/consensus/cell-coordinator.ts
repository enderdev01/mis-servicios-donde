import { DurableObject } from 'cloudflare:workers';

import { AlertsService } from '../alerts/alerts.service.js';
import type { Env } from '../env.js';
import { ReportRequestError } from '../reports/report-input.js';
import { ReportIntake, type IntakeJob } from '../reports/report-intake.js';
import { ConsensusService } from './consensus.service.js';

export type IntakeOutcome = { accepted: true; submissionId: string } | { rejected: ReportRequestError['body']; status: ReportRequestError['status'] };

/**
 * One instance per H3 cell (named by the cell). It holds no state: it only runs the intake and consensus
 * write path one job at a time, which is the lock D1 does not offer. A Durable Object only gates input
 * around its own storage, not around D1 calls, so the queue is explicit.
 */
export class CellCoordinator extends DurableObject<Env> {
  private queue: Promise<unknown> = Promise.resolve();

  intake(job: IntakeJob): Promise<IntakeOutcome> {
    const run = this.queue.then(() => this.run(job));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Rejections cross the RPC boundary as data: an Error subclass would arrive as a plain Error. */
  private async run(job: IntakeJob): Promise<IntakeOutcome> {
    const consensus = new ConsensusService(new AlertsService(this.env.DB), this.env.DB);
    try {
      return await new ReportIntake(consensus, this.env.DB).persist(job);
    } catch (error) {
      if (error instanceof ReportRequestError) return { rejected: error.body, status: error.status };
      throw error;
    }
  }
}
