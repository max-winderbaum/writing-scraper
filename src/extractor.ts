import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import type { Article, ScrapedPage, ExtractionOptions } from './types.js';

// Clean title by removing site name suffixes
function cleanTitle(title: string): string {
  const separators = [' | ', ' - ', ' :: ', ' – ', ' — '];
  for (const sep of separators) {
    const parts = title.split(sep);
    if (parts.length > 1) {
      // Return the longest part (usually the article title, not site name)
      return parts.reduce((a, b) => a.length > b.length ? a : b).trim();
    }
  }
  return title.trim();
}

// Extract title with priority: JSON-LD > og:title > h1 > title
function extractTitle(document: Document): string {
  // Try JSON-LD first
  const jsonLdScript = document.querySelector('script[type="application/ld+json"]');
  if (jsonLdScript && jsonLdScript.textContent) {
    try {
      const data = JSON.parse(jsonLdScript.textContent);
      // Handle arrays of schemas
      const schema = Array.isArray(data) ? data[0] : data;
      if (schema?.headline) {
        return cleanTitle(schema.headline);
      }
      // Check @graph for nested schemas
      if (schema?.['@graph']) {
        for (const item of schema['@graph']) {
          if (item.headline) {
            return cleanTitle(item.headline);
          }
        }
      }
    } catch {
      // Invalid JSON, continue to other methods
    }
  }

  // Try Open Graph title
  const ogTitle = document.querySelector('meta[property="og:title"]');
  if (ogTitle) {
    const content = ogTitle.getAttribute('content');
    if (content) {
      return cleanTitle(content);
    }
  }

  // Try h1 in article context
  const articleH1 = document.querySelector('article h1, main h1, .post h1, .entry h1');
  if (articleH1 && articleH1.textContent) {
    return cleanTitle(articleH1.textContent);
  }

  // Try any h1
  const h1 = document.querySelector('h1');
  if (h1 && h1.textContent) {
    return cleanTitle(h1.textContent);
  }

  // Fall back to document title
  return cleanTitle(document.title || 'Untitled');
}

export function extractArticle(
  page: ScrapedPage,
  options: ExtractionOptions = {}
): Article | null {
  const minBodyLength = options.minBodyLength || 100;

  try {
    const { document } = parseHTML(page.html);

    // Set the URL for proper resolution
    // linkedom doesn't support setting URL directly, but Readability handles relative URLs

    // Use Readability for content extraction
    const reader = new Readability(document as unknown as Document);
    const article = reader.parse();

    if (!article) {
      console.log(`Readability failed for ${page.url}`);
      return null;
    }

    // Use Readability's textContent directly (already plain text)
    const body = article.textContent?.trim() || '';

    if (body.length < minBodyLength) {
      console.log(`Article too short (${body.length} chars) for ${page.url}`);
      return null;
    }

    // Extract title with our enhanced logic
    const title = extractTitle(document as unknown as Document) || article.title || 'Untitled';

    return {
      title: title.trim(),
      body: body.trim(),
    };
  } catch (error) {
    console.error(`Extraction failed for ${page.url}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

export function extractArticles(
  pages: ScrapedPage[],
  options: ExtractionOptions = {}
): Article[] {
  const articles: Article[] = [];

  for (const page of pages) {
    const article = extractArticle(page, options);
    if (article) {
      articles.push(article);
      console.log(`Extracted: "${article.title}" (${article.body.length} chars)`);
    }
  }

  return articles;
}
