import type { Requester } from '../../../lib/api.ts';
import type { MailMode } from '../domain/mailState.ts';

const MAIL_MUTATION_INVALIDATIONS = [
  '/admin/mails',
  '/admin/mails_unknow',
  '/admin/sendbox',
  '/admin/statistics',
];

export interface MailMutationGateway {
  delete(mode: MailMode, mailId: number): Promise<void>;
}

function assertMailId(mailId: number): void {
  if (!Number.isSafeInteger(mailId) || mailId <= 0) {
    throw new TypeError('mailId must be a positive integer');
  }
}

export function createMailMutationGateway(request: Requester): MailMutationGateway {
  return {
    async delete(mode: MailMode, mailId: number): Promise<void> {
      assertMailId(mailId);
      const endpoint = mode === 'sent' ? '/admin/sendbox' : '/admin/mails';
      await request(`${endpoint}/${mailId}`, {
        method: 'DELETE',
        invalidates: MAIL_MUTATION_INVALIDATIONS,
      });
    },
  };
}
