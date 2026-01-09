import Sitemapper from 'sitemapper';
import { parseStringPromise } from 'xml2js';
import type { DiscoveryResult } from './types.js';

// URL patterns that likely indicate article pages
const ARTICLE_PATTERNS = [
  /\/\d{4}\/\d{1,2}(\/\d{1,2})?\/[\w-]+/,  // /2025/01/09/slug
  /\/(article|post|blog|news|story|p)\/[\w-]+/,
  /\/\d+-[\w-]+$/,  // /12345-article-title
];

// URL patterns to exclude (navigation, categories, etc.)
const EXCLUDE_PATTERNS = [
  /\/(tag|category|author|archive|search|login|page|about|contact|subscribe|podcast)(\/|$)/i,
  /[?&](sort|filter|page)=/,
  /\.(css|js|jpg|jpeg|png|gif|pdf|xml|json)$/i,
  /\/(feed|rss|atom)(\/|$)/i,
];

function isLikelyArticle(url: string): boolean {
  try {
    const path = new URL(url).pathname;

    // Check exclusions first
    for (const pattern of EXCLUDE_PATTERNS) {
      if (pattern.test(path) || pattern.test(url)) {
        return false;
      }
    }

    // Check if matches article patterns
    for (const pattern of ARTICLE_PATTERNS) {
      if (pattern.test(path)) {
        return true;
      }
    }

    // For Substack and similar platforms, posts often have /p/ prefix
    if (path.includes('/p/')) {
      return true;
    }

    // Fallback: if path has reasonable depth and slug-like end
    const segments = path.split('/').filter(Boolean);
    if (segments.length >= 1) {
      const lastSegment = segments[segments.length - 1];
      // Check for slug-like patterns (lowercase, hyphens)
      if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(lastSegment) && lastSegment.length > 5) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

async function discoverFromSitemap(baseUrl: string, limit: number): Promise<string[]> {
  const sitemapper = new Sitemapper({
    url: `${baseUrl}/sitemap.xml`,
    timeout: 15000,
  });

  try {
    const { sites } = await sitemapper.fetch();

    // Filter to likely article URLs
    const articleUrls = sites.filter(isLikelyArticle);

    return articleUrls.slice(0, limit);
  } catch (error) {
    // Try sitemap_index.xml
    try {
      const indexMapper = new Sitemapper({
        url: `${baseUrl}/sitemap_index.xml`,
        timeout: 15000,
      });
      const { sites } = await indexMapper.fetch();
      return sites.filter(isLikelyArticle).slice(0, limit);
    } catch {
      throw error;
    }
  }
}

async function discoverFromRss(baseUrl: string, limit: number): Promise<string[]> {
  const feedPaths = ['/feed', '/rss', '/rss.xml', '/atom.xml', '/feed.xml'];

  for (const path of feedPaths) {
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        headers: { 'Accept': 'application/rss+xml, application/xml, text/xml' }
      });

      if (!response.ok) continue;

      const text = await response.text();
      const parsed = await parseStringPromise(text);

      const urls: string[] = [];

      // RSS format
      const items = parsed?.rss?.channel?.[0]?.item || [];
      for (const item of items) {
        const link = item.link?.[0];
        if (link && typeof link === 'string') {
          urls.push(link);
        }
      }

      // Atom format
      const entries = parsed?.feed?.entry || [];
      for (const entry of entries) {
        const link = entry.link?.[0]?.$.href;
        if (link) {
          urls.push(link);
        }
      }

      if (urls.length > 0) {
        return urls.slice(0, limit);
      }
    } catch {
      continue;
    }
  }

  throw new Error('No RSS/Atom feed found');
}

async function discoverFromLinks(
  baseUrl: string,
  limit: number,
  fetchPage: (url: string) => Promise<string>
): Promise<string[]> {
  const html = await fetchPage(baseUrl);

  // Extract all links from the page
  const linkRegex = /href=["']([^"']+)["']/gi;
  const urls = new Set<string>();

  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1];
    try {
      const absoluteUrl = new URL(href, baseUrl).href;
      const urlObj = new URL(absoluteUrl);

      // Only include links from the same domain
      if (urlObj.origin === new URL(baseUrl).origin && isLikelyArticle(absoluteUrl)) {
        urls.add(absoluteUrl);
      }
    } catch {
      // Invalid URL, skip
    }
  }

  return Array.from(urls).slice(0, limit);
}

export async function discoverArticleUrls(
  url: string,
  limit: number = 10,
  fetchPage?: (url: string) => Promise<string>
): Promise<DiscoveryResult> {
  // Normalize URL
  const baseUrl = url.replace(/\/+$/, '');

  // Try sitemap first (most reliable)
  try {
    console.log(`Trying sitemap discovery for ${baseUrl}...`);
    const urls = await discoverFromSitemap(baseUrl, limit);
    if (urls.length > 0) {
      console.log(`Found ${urls.length} URLs from sitemap`);
      return { urls, method: 'sitemap' };
    }
  } catch (error) {
    console.log('Sitemap discovery failed, trying RSS...');
  }

  // Try RSS/Atom feeds
  try {
    const urls = await discoverFromRss(baseUrl, limit);
    if (urls.length > 0) {
      console.log(`Found ${urls.length} URLs from RSS feed`);
      return { urls, method: 'rss' };
    }
  } catch (error) {
    console.log('RSS discovery failed, trying link following...');
  }

  // Fall back to link following
  if (fetchPage) {
    try {
      const urls = await discoverFromLinks(baseUrl, limit, fetchPage);
      if (urls.length > 0) {
        console.log(`Found ${urls.length} URLs from page links`);
        return { urls, method: 'links' };
      }
    } catch (error) {
      console.log('Link following failed');
    }
  }

  throw new Error(`Could not discover article URLs for ${baseUrl}`);
}
