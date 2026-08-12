import { buildQuery, type Requester } from '../../../lib/api.ts';
import { adminMailStateEndpoint } from '../../../lib/mailStateEndpoint.ts';
import type { MailMode, RemoteMailStateLike } from '../domain/mailState.ts';

export interface AdminMailStateGateway {
  load(mode: MailMode): Promise<RemoteMailStateLike>;
  patch(mode: MailMode, body: Record<string, unknown>): Promise<RemoteMailStateLike>;
}

export function createAdminMailStateGateway(request: Requester): AdminMailStateGateway {
  return {
    load(mode: MailMode): Promise<RemoteMailStateLike> {
      return request<RemoteMailStateLike>(adminMailStateEndpoint(buildQuery({ mode })), {
        forceRefresh: true,
        skipCache: true,
        timeoutMs: 6500,
        reportAuthFailure: false,
      });
    },
    patch(mode: MailMode, body: Record<string, unknown>): Promise<RemoteMailStateLike> {
      return request<RemoteMailStateLike>(adminMailStateEndpoint(), {
        method: 'PATCH',
        body: { mode, ...body },
        timeoutMs: 6500,
        reportAuthFailure: false,
        invalidates: ['/api/mail-state'],
      });
    },
  };
}
