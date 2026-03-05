import {
  ResearchServiceClient,
  type ArxivPaper,
  type GithubRepo,
  type HackernewsItem,
  type ListTechEventsResponse,
} from '@/generated/client/worldmonitor/research/v1/service_client';
import { createCircuitBreaker } from '@/utils';

// Re-export proto types (no legacy mapping needed -- proto types are clean)
export type { ArxivPaper, GithubRepo, HackernewsItem };

const httpGet = globalThis.fetch;
const client = new ResearchServiceClient('', { fetch: (...args: Parameters<typeof httpGet>) => httpGet(...args) });

const arxivBreaker = createCircuitBreaker<ArxivPaper[]>({ name: 'ArXiv Papers', cacheTtlMs: 10 * 60 * 1000, persistCache: true });
const trendingBreaker = createCircuitBreaker<GithubRepo[]>({ name: 'GitHub Trending', cacheTtlMs: 10 * 60 * 1000, persistCache: true });
const hnBreaker = createCircuitBreaker<HackernewsItem[]>({ name: 'Hacker News', cacheTtlMs: 10 * 60 * 1000, persistCache: true });

export async function fetchArxivPapers(
  category = 'cs.AI',
  query = '',
  pageSize = 50,
): Promise<ArxivPaper[]> {
  return arxivBreaker.execute(async () => {
    const resp = await client.listArxivPapers({
      category,
      query,
      pageSize,
      cursor: '',
    });
    return resp.papers;
  }, []);
}

export async function fetchTrendingRepos(
  language = 'python',
  period = 'daily',
  pageSize = 50,
): Promise<GithubRepo[]> {
  return trendingBreaker.execute(async () => {
    const resp = await client.listTrendingRepos({
      language,
      period,
      pageSize,
      cursor: '',
    });
    return resp.repos;
  }, []);
}

export async function fetchHackernewsItems(
  feedType = 'top',
  pageSize = 30,
): Promise<HackernewsItem[]> {
  return hnBreaker.execute(async () => {
    const resp = await client.listHackernewsItems({
      feedType,
      pageSize,
      cursor: '',
    });
    return resp.items;
  }, []);
}

export async function fetchTechEvents(
  type = 'conference',
  mappable = true,
  days = 90,
  limit = 50,
): Promise<ListTechEventsResponse> {
  return client.listTechEvents({
    type,
    mappable,
    days,
    limit,
  });
}
