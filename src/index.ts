import { discoverArticleUrls } from './discovery.js';
import { createScraper, ArticleScraper } from './scraper.js';
import { extractArticle } from './extractor.js';
import type { Article } from './types.js';

export interface ExtractOptions {
  count?: number;
  verbose?: boolean;
  maxAttempts?: number;
}

export async function extractArticlesFromSite(
  siteUrl: string,
  options: ExtractOptions = {}
): Promise<Article[]> {
  const targetCount = options.count || 10;
  const verbose = options.verbose ?? true;
  const maxAttempts = options.maxAttempts || targetCount * 3; // Try up to 3x URLs to hit target

  let scraper: ArticleScraper | null = null;

  try {
    // Initialize browser
    if (verbose) console.log('Initializing browser...');
    scraper = await createScraper();

    // Discover article URLs (get more than needed to handle failures)
    if (verbose) console.log(`\nDiscovering articles from ${siteUrl}...`);

    const discovery = await discoverArticleUrls(
      siteUrl,
      maxAttempts,
      (url) => scraper!.fetchPageHtml(url)
    );

    if (verbose) {
      console.log(`Discovered ${discovery.urls.length} URLs via ${discovery.method}`);
    }

    // Process URLs until we have enough successful extractions
    const articles: Article[] = [];
    const processedUrls = new Set<string>();
    let urlIndex = 0;

    if (verbose) console.log(`\nExtracting ${targetCount} articles...`);

    while (articles.length < targetCount && urlIndex < discovery.urls.length) {
      const url = discovery.urls[urlIndex];
      urlIndex++;

      if (processedUrls.has(url)) continue;
      processedUrls.add(url);

      try {
        if (verbose) {
          console.log(`\n[${articles.length + 1}/${targetCount}] Scraping: ${url}`);
        }

        const page = await scraper.scrapePage(url, {
          waitForJs: true,
          blockResources: true,
        });

        const article = extractArticle(page, { minBodyLength: 100 });

        if (article) {
          articles.push(article);
          if (verbose) {
            console.log(`  ✓ Extracted: "${article.title}" (${article.body.length} chars)`);
          }
        } else {
          if (verbose) {
            console.log(`  ✗ Skipped (extraction failed or too short)`);
          }
        }

        // Politeness delay
        if (urlIndex < discovery.urls.length && articles.length < targetCount) {
          await new Promise((resolve) => setTimeout(resolve, 1000 + Math.random() * 1000));
        }
      } catch (error) {
        if (verbose) {
          console.log(`  ✗ Error: ${error instanceof Error ? error.message : error}`);
        }
      }
    }

    if (verbose) {
      console.log(`\nExtracted ${articles.length}/${targetCount} articles`);
      if (articles.length < targetCount) {
        console.log(`(Could not find ${targetCount} extractable articles from ${processedUrls.size} URLs tried)`);
      }
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
