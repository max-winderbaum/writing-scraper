export interface Article {
  title: string;
  body: string;
}

export interface ScrapedPage {
  url: string;
  html: string;
}

export interface DiscoveryResult {
  urls: string[];
  method: 'sitemap' | 'rss' | 'links';
}

export interface ExtractionOptions {
  minBodyLength?: number;
}

export interface ScraperOptions {
  timeout?: number;
  waitForJs?: boolean;
  blockResources?: boolean;
}
