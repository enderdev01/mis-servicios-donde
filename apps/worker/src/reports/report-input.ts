import { type ReportInput, type ReportStatus, type Service, reportInputSchema } from '@mis-servicios/contracts';

import { sanitizeDisplayName } from '../trust/trust.service.js';

export type { ReportInput, ReportStatus };
export type ReportServiceName = Service;

export class ReportRequestError extends Error {
  constructor(public readonly status: 400 | 409, public readonly body: { code: string; message: string }) {
    super(body.message);
  }
}

/**
 * Every rejection answers with the same generic error: a caller learns that the
 * report was not accepted, never which field gave it away.
 */
export function validateReportInput(value: unknown): ReportInput {
  const parsed = reportInputSchema.safeParse(value);
  if (!parsed.success) throw unavailable();
  return { ...parsed.data, name: sanitizeDisplayName(parsed.data.name) };
}

export function unavailable(): ReportRequestError {
  return new ReportRequestError(400, { code: 'report_unavailable', message: 'Unable to process report.' });
}

export function conflict(): ReportRequestError {
  return new ReportRequestError(409, { code: 'submission_conflict', message: 'Submission identifier conflicts with prior input.' });
}

/** A device already reported in the window; it is told so, not refused generically. */
export function alreadyReported(): ReportRequestError {
  return new ReportRequestError(409, { code: 'already_reported', message: 'This device already reported a cut.' });
}
