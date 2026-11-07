import type { RedditListing } from '../reddit-api.js';
import { LISTING_BLOCKED, redditGet, redditGetDocument } from '../reddit-api.js';
import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';

interface SearchResult {
  id: string;
  name: string;
  title: string;
  author: string;
  subreddit: string;
  score: number;
  num_comments: number;
  url: string;
  permalink: string;
  selftext: string;
  is_self: boolean;
  created_utc: number;
}

interface SearchPost {
  id: string;
  name: string;
  title: string;
  author: string;
  subreddit: string;
  score: number;
  num_comments: number;
  url: string | null;
  permalink: string;
  selftext: string | null;
  is_self: boolean | null;
  created_utc: number;
}

interface SearchParams {
  query: string;
  subreddit?: string;
  sort?: string;
  t?: string;
  limit?: number;
  after?: string;
  include_body?: boolean;
}

/**
 * Prefix for pagination cursors that come from the search results page rather than
 * search.json. Format: `page:<skip>:<cursor>` — `cursor` is the results page's own
 * continuation token (empty for the first page) and `skip` counts the results on
 * that page that were already returned.
 */
const PAGE_CURSOR_PREFIX = 'page:';
/** Upper bound on result pages fetched for one call (each page holds a handful of posts). */
const MAX_RESULT_PAGES = 15;
/** Concurrent post lookups when include_body needs details the results page does not show. */
const DETAIL_CONCURRENCY = 5;

interface TrackingContext {
  post?: { id?: string; title?: string };
  profile?: { name?: string };
  subreddit?: { name?: string };
}

const readTrackingContext = (el: Element | null): TrackingContext => {
  const raw = el?.getAttribute('data-faceplate-tracking-context');
  if (!raw) return {};
  try {
    return JSON.parse(raw) as TrackingContext;
  } catch {
    return {};
  }
};

/** Find the smallest ancestor of `start` that holds this post's counter row and no other post. */
const findPostUnit = (start: Element): Element | null => {
  let el = start.parentElement;
  while (el) {
    if (el.querySelector('[data-testid="search-counter-row"]')) {
      return el.querySelectorAll('a[data-testid="post-title"]').length === 1 ? el : null;
    }
    el = el.parentElement;
  }
  return null;
};

const readCount = (unit: Element | null, label: string): number => {
  const numbers = unit?.querySelectorAll('[data-testid="search-counter-row"] faceplate-number') ?? [];
  for (const n of numbers) {
    if ((n.parentElement?.textContent ?? '').toLowerCase().includes(label)) {
      const value = Number(n.getAttribute('number'));
      return Number.isFinite(value) ? value : 0;
    }
  }
  return 0;
};

/** Extract post results from a server-rendered search results page or partial. */
const parseResultsPage = (doc: Document): SearchPost[] => {
  const posts: SearchPost[] = [];
  const seen = new Set<string>();
  for (const link of doc.querySelectorAll('a[data-testid="post-title"]')) {
    const tracker = link.closest('[data-faceplate-tracking-context]');
    const context = readTrackingContext(tracker);
    const fullname = context.post?.id;
    if (!fullname?.startsWith('t3_') || seen.has(fullname)) continue;
    seen.add(fullname);
    const unit = findPostUnit(tracker ?? link);
    const ts = unit?.querySelector('faceplate-timeago')?.getAttribute('ts');
    const created = ts ? Date.parse(ts) : Number.NaN;
    posts.push({
      id: fullname.slice(3),
      name: fullname,
      title: context.post?.title ?? link.getAttribute('aria-label') ?? '',
      author: context.profile?.name ?? '[deleted]',
      subreddit: context.subreddit?.name ?? '',
      score: readCount(unit, 'vote'),
      num_comments: readCount(unit, 'comment'),
      url: null,
      permalink: link.getAttribute('href') ?? '',
      selftext: null,
      is_self: null,
      created_utc: Number.isFinite(created) ? Math.floor(created / 1000) : 0,
    });
  }
  return posts;
};

/** Continuation token for the next results page, if the page links one. */
const readNextCursor = (doc: Document): string | null => {
  for (const partial of doc.querySelectorAll('faceplate-partial[src*="cursor="]')) {
    const src = partial.getAttribute('src') ?? '';
    if (!src.includes('/search/')) continue;
    const cursor = new URL(src, 'https://www.reddit.com').searchParams.get('cursor');
    if (cursor) return cursor;
  }
  return null;
};

const parsePageCursor = (after: string | undefined): { skip: number; cursor: string } => {
  if (!after?.startsWith(PAGE_CURSOR_PREFIX)) return { skip: 0, cursor: '' };
  const rest = after.slice(PAGE_CURSOR_PREFIX.length);
  const sep = rest.indexOf(':');
  const skip = Number.parseInt(sep === -1 ? rest : rest.slice(0, sep), 10);
  return { skip: Number.isFinite(skip) && skip > 0 ? skip : 0, cursor: sep === -1 ? '' : rest.slice(sep + 1) };
};

/** Fill in body, URL, exact score and post type from the single-post JSON endpoint. */
const addPostDetails = async (posts: SearchPost[]): Promise<void> => {
  for (let i = 0; i < posts.length; i += DETAIL_CONCURRENCY) {
    await Promise.all(
      posts.slice(i, i + DETAIL_CONCURRENCY).map(async post => {
        const data = await redditGet<[RedditListing<SearchResult>]>(`/comments/${post.id}.json`, {
          limit: '1',
          depth: '1',
          raw_json: '1',
        });
        const detail = data[0]?.data.children[0]?.data;
        if (!detail) return;
        post.url = detail.url;
        post.selftext = detail.selftext ?? '';
        post.is_self = detail.is_self;
        post.score = detail.score;
        post.num_comments = detail.num_comments;
        post.created_utc = detail.created_utc;
      }),
    );
  }
};

/**
 * Search through the server-rendered results page that Reddit serves to logged-in
 * browsers. Used when search.json is blocked for the session. Each page holds a few
 * posts, so pages are followed until `limit` results are collected.
 */
const searchResultsPage = async (params: SearchParams): Promise<{ posts: SearchPost[]; after: string | null }> => {
  const limit = params.limit ?? 25;
  const basePath = params.subreddit ? `/r/${params.subreddit}/search/` : '/search/';
  const query: Record<string, string> = { q: params.query, type: 'posts' };
  if (params.sort) query.sort = params.sort;
  if (params.t) query.t = params.t;

  let { skip, cursor } = parsePageCursor(params.after);
  const posts: SearchPost[] = [];
  const seen = new Set<string>();
  let after: string | null = null;

  for (let page = 0; page < MAX_RESULT_PAGES; page++) {
    const doc = cursor
      ? await redditGetDocument(`/svc/shreddit${basePath}`, { ...query, cursor })
      : await redditGetDocument(basePath, query);
    const pagePosts = parseResultsPage(doc);
    const nextCursor = readNextCursor(doc);

    let taken = skip;
    for (const post of pagePosts.slice(skip)) {
      if (posts.length >= limit) break;
      taken++;
      if (seen.has(post.name)) continue;
      seen.add(post.name);
      posts.push(post);
    }

    if (taken < pagePosts.length) {
      after = `${PAGE_CURSOR_PREFIX}${taken}:${cursor}`;
      break;
    }
    if (!nextCursor || pagePosts.length === 0) break;
    cursor = nextCursor;
    skip = 0;
    if (posts.length >= limit) {
      after = `${PAGE_CURSOR_PREFIX}0:${cursor}`;
      break;
    }
  }

  if (params.include_body) await addPostDetails(posts);
  return { posts, after };
};

export const searchPosts = defineTool({
  name: 'search_posts',
  displayName: 'Search Posts',
  description:
    'Search for posts across Reddit or within a specific subreddit. Supports sorting and time filtering. ' +
    'When Reddit blocks the JSON search API for the session, results come from the search results page instead; ' +
    'pass the returned "after" cursor unchanged to get the next page.',
  summary: 'Search Reddit posts',
  icon: 'search',
  group: 'Posts',
  input: z.object({
    query: z.string().min(1).describe('Search query string'),
    subreddit: z.string().optional().describe('Restrict search to this subreddit (without r/ prefix)'),
    sort: z
      .enum(['relevance', 'hot', 'top', 'new', 'comments'])
      .optional()
      .describe('Sort order (default "relevance")'),
    t: z
      .enum(['hour', 'day', 'week', 'month', 'year', 'all'])
      .optional()
      .describe('Time period filter (default "all")'),
    limit: z.number().int().min(1).max(100).optional().describe('Number of results (default 25, max 100)'),
    after: z.string().optional().describe('Pagination cursor from a previous call (pass it back unchanged)'),
    include_body: z
      .boolean()
      .optional()
      .describe(
        'Whether to include post body text (selftext) and external URL. Defaults to false — titles and metadata only. Set true when you need to read post contents (doubles-to-triples the response size).',
      ),
  }),
  output: z.object({
    posts: z
      .array(
        z.object({
          id: z.string().describe('Post ID'),
          name: z.string().describe('Post fullname'),
          title: z.string().describe('Post title'),
          author: z.string().describe('Author username'),
          subreddit: z.string().describe('Subreddit name'),
          score: z.number().describe('Post score'),
          num_comments: z.number().describe('Number of comments'),
          url: z.string().nullable().describe('Post URL — null when include_body is false'),
          permalink: z.string().describe('Reddit permalink'),
          selftext: z.string().nullable().describe('Self post body — null when include_body is false'),
          is_self: z
            .boolean()
            .nullable()
            .describe('Whether this is a text post — null when unknown (results page served without include_body)'),
          created_utc: z.number().describe('Creation timestamp'),
        }),
      )
      .describe('Search results'),
    after: z.string().nullable().describe('Pagination cursor for next page'),
  }),
  handle: async params => {
    if (params.after?.startsWith(PAGE_CURSOR_PREFIX)) return searchResultsPage(params);

    const base = params.subreddit ? `/r/${params.subreddit}` : '';
    const includeBody = params.include_body ?? false;
    const queryParams: Record<string, string> = {
      q: params.query,
      limit: String(params.limit ?? 25),
      restrict_sr: params.subreddit ? 'true' : 'false',
    };
    if (params.sort) queryParams.sort = params.sort;
    if (params.t) queryParams.t = params.t;
    if (params.after) queryParams.after = params.after;

    let data: RedditListing<SearchResult>;
    try {
      data = await redditGet<RedditListing<SearchResult>>(`${base}/search.json`, queryParams);
    } catch (error) {
      if (error instanceof ToolError && error.code === LISTING_BLOCKED && !params.after) {
        return searchResultsPage(params);
      }
      throw error;
    }

    return {
      posts: data.data.children.map(child => ({
        id: child.data.id,
        name: child.data.name,
        title: child.data.title,
        author: child.data.author,
        subreddit: child.data.subreddit,
        score: child.data.score,
        num_comments: child.data.num_comments,
        url: includeBody ? child.data.url : null,
        permalink: child.data.permalink,
        selftext: includeBody ? (child.data.selftext ?? '') : null,
        is_self: child.data.is_self,
        created_utc: child.data.created_utc,
      })),
      after: data.data.after ?? null,
    };
  },
});
