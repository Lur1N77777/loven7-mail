import { buildQuery, type Requester } from '../../../lib/api.ts';
import { CACHE_TTL } from '../../../lib/constants.ts';
import { parseRawMailListItem, parseSendbox } from '../../../lib/mailParser.ts';
import type { ListResponse, ParsedMail, ParsedSendbox, RawMailRecord, SendboxRecord } from '../../../types/api.ts';
import type { MailMode } from '../domain/mailState.ts';

export type MailListRequest = {
  mode: MailMode;
  offset: number;
  limit: number;
  address?: string;
  forceRefresh?: boolean;
  signal?: AbortSignal;
};

export type MailListResult = {
  results: Array<ParsedMail | ParsedSendbox>;
  count: number;
};

export interface MailListGateway {
  load(input: MailListRequest): Promise<MailListResult>;
}

function normalizePageValue(value: number, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : fallback;
}

export function createMailListGateway(request: Requester): MailListGateway {
  return {
    async load(input: MailListRequest): Promise<MailListResult> {
      const offset = normalizePageValue(input.offset, 0);
      const limit = Math.max(1, normalizePageValue(input.limit, 20));
      const address = String(input.address || '').trim();
      const query = buildQuery({
        limit,
        offset,
        address: input.mode === 'unknown' ? '' : address,
      });
      if (input.mode === 'sent') {
        const response = await request<ListResponse<SendboxRecord>>(`/admin/sendbox${query}`, {
          forceRefresh: Boolean(input.forceRefresh),
          signal: input.signal,
          cacheTtlMs: CACHE_TTL.shortList,
        });
        return {
          results: (response.results || []).map(parseSendbox),
          count: response.count,
        };
      }

      const endpoint = input.mode === 'unknown' ? '/admin/mails_unknow' : '/admin/mails';
      const response = await request<ListResponse<RawMailRecord>>(`${endpoint}${query}`, {
        forceRefresh: Boolean(input.forceRefresh),
        signal: input.signal,
        cacheTtlMs: CACHE_TTL.shortList,
      });
      return {
        results: (response.results || []).map(parseRawMailListItem),
        count: response.count,
      };
    },
  };
}
