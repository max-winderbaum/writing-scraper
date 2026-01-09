import { chromium, Browser, Page, BrowserContext } from 'playwright';
import type { ScrapedPage, ScraperOptions } from './types.js';

// Resource types to block for faster loading
const BLOCK_TYPES = ['image', 'stylesheet', 'media', 'font'];

export class ArticleScraper {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;

  async init(): Promise<void> {
    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
      ],
    });

    this.context = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
    });
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.context.close();
    }
    if (this.browser) {
      await this.browser.close();
    }
  }

  private async configurePage(page: Page, options: ScraperOptions): Promise<void> {
    // Block unnecessary resources for faster loading
    if (options.blockResources !== false) {
      await page.route('**/*', (route) => {
        const resourceType = route.request().resourceType();
        if (BLOCK_TYPES.includes(resourceType)) {
          return route.abort();
        }
        return route.continue();
      });
    }
  }

  private async waitForContent(page: Page): Promise<void> {
    // Wait for network to settle (JS content to load)
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {
      // If networkidle times out, continue anyway
    });

    // Try to wait for article content selectors
    const contentSelectors = [
      'article .body',           // Substack
      '.available-content',      // Substack paywall preview
      'article',
      'main',
      '.content',
      '[role="article"]',
      '.post-content',
      '.entry-content',
    ];

    await page.waitForSelector(contentSelectors.join(', '), {
      state: 'visible',
      timeout: 10000,
    }).catch(() => {
      // If no article container found, that's ok - we'll extract what we can
    });
  }

  async scrapePage(url: string, options: ScraperOptions = {}): Promise<ScrapedPage> {
    if (!this.context) {
      throw new Error('Scraper not initialized. Call init() first.');
    }

    const timeout = options.timeout || 30000;
    const page = await this.context.newPage();

    try {
      await this.configurePage(page, options);

      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout,
      });

      if (options.waitForJs !== false) {
        await this.waitForContent(page);
      }

      const html = await page.content();

      return { url, html };
    } finally {
      await page.close();
    }
  }

  async scrapePages(
    urls: string[],
    options: ScraperOptions = {},
    onProgress?: (completed: number, total: number) => void
  ): Promise<ScrapedPage[]> {
    const results: ScrapedPage[] = [];

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];

      try {
        console.log(`Scraping (${i + 1}/${urls.length}): ${url}`);
        const result = await this.scrapePage(url, options);
        results.push(result);

        onProgress?.(i + 1, urls.length);

        // Politeness delay between requests
        if (i < urls.length - 1) {
          const delay = 1000 + Math.random() * 1000;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      } catch (error) {
        console.error(`Failed to scrape ${url}:`, error instanceof Error ? error.message : error);
      }
    }

    return results;
  }

  // Helper for discovery fallback - fetch page HTML
  async fetchPageHtml(url: string): Promise<string> {
    const result = await this.scrapePage(url);
    return result.html;
  }
}

export async function createScraper(): Promise<ArticleScraper> {
  const scraper = new ArticleScraper();
  await scraper.init();
  return scraper;
}
