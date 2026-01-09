import { discoverArticleUrls } from './discovery.js';
import { createScraper, ArticleScraper } from './scraper.js';
import { extractArticles } from './extractor.js';
import type { Article } from './types.js';

export interface ExtractOptions {
  count?: number;
  verbose?: boolean;
}

export async function extractArticlesFromSite(
  siteUrl: string,
  options: ExtractOptions = {}
): Promise<Article[]> {
  const count = options.count || 10;
  const verbose = options.verbose ?? true;

  let scraper: ArticleScraper | null = null;

  try {
    // Initialize browser
    if (verbose) console.log('Initializing browser...');
    scraper = await createScraper();

    // Discover article URLs
    if (verbose) console.log(`\nDiscovering articles from ${siteUrl}...`);

    // Pass scraper's fetch function for link-following fallback
    const discovery = await discoverArticleUrls(
      siteUrl,
      count,
      (url) => scraper!.fetchPageHtml(url)
    );

    if (verbose) {
      console.log(`\nDiscovered ${discovery.urls.length} URLs via ${discovery.method}`);
      console.log('URLs to scrape:');
      discovery.urls.forEach((url, i) => console.log(`  ${i + 1}. ${url}`));
    }

    // Scrape each article page
    if (verbose) console.log('\nScraping articles...');
    const pages = await scraper.scrapePages(discovery.urls, {
      waitForJs: true,
      blockResources: true,
    });

    if (verbose) console.log(`\nSuccessfully scraped ${pages.length} pages`);

    // Extract article content
    if (verbose) console.log('\nExtracting content...');
    const articles = extractArticles(pages, { minBodyLength: 100 });

    if (verbose) {
      console.log(`\nExtracted ${articles.length} articles`);
    }

    return articles;
  } finally {
    if (scraper) {
      await scraper.close();
    }
  }
}

// Re-export types and modules
export type { Article, ScrapedPage, DiscoveryResult } from './types.js';
export { discoverArticleUrls } from './discovery.js';
export { createScraper, ArticleScraper } from './scraper.js';
export { extractArticle, extractArticles } from './extractor.js';
