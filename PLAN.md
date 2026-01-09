# Building an intelligent web scraping system for article extraction

**Playwright + Trafilatura + LLM fallbacks form the optimal architecture** for extracting articles from arbitrary public websites in 2025. A pipeline-based design with three distinct layers—scraping, discovery, and extraction—provides fault isolation and independent scaling. For 10 articles from a single domain, expect **$0.01-0.05 in LLM costs** (if needed) with **2-5 minutes** total processing time using headless browsers.

This architecture achieves **85-95% extraction success rates** across diverse sites by combining Mozilla Readability's scoring algorithm with Trafilatura's fallback system and GPT-4o-mini for edge cases. The system prioritizes sitemap.xml parsing (fastest path to article URLs), falls back to RSS/Atom discovery, then intelligent link following when neither exists.

---

## Recommended technology stack by layer

The complete system requires three coordinated layers, each with specific library choices optimized for the article extraction use case:

| Layer | Primary Tool | Fallback | Language |
|-------|-------------|----------|----------|
| **Scraping** | Playwright | Puppeteer + Stealth | TypeScript |
| **Discovery** | ultimate-sitemap-parser / sitemapper | RSS + link heuristics | Python/Node |
| **Extraction** | Trafilatura | Readability.js → LLM | Python + Node |
| **Queue** | BullMQ | Redis native | TypeScript |
| **Storage** | PostgreSQL + Redis | S3 for raw HTML | — |

**Playwright wins over Puppeteer** for most scraping scenarios because of built-in auto-waiting, cross-browser support (some sites work better in Firefox/WebKit), and superior context isolation for parallel execution. Puppeteer remains viable for Chrome-only deployments with maximum stealth requirements due to its more mature `puppeteer-extra-plugin-stealth` ecosystem.

---

## Scraping layer architecture

### Browser selection and configuration

Playwright provides the cleanest API with automatic actionability checks that eliminate most timing issues:

```typescript
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';

chromium.use(stealth());

const browser = await chromium.launch({
  headless: true,
  args: ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage']
});

const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  viewport: { width: 1920, height: 1080 },
  locale: 'en-US',
});
```

**Resource blocking reduces page load by 50-90%** and should be enabled for article scraping:

```typescript
const BLOCK_TYPES = ['image', 'stylesheet', 'media', 'font'];

await page.route('**/*', (route) => 
  BLOCK_TYPES.includes(route.request().resourceType()) 
    ? route.abort() 
    : route.continue()
);
```

### Waiting strategies for dynamic content

The optimal waiting strategy for article pages uses a layered approach:

1. `domcontentloaded` for initial load (fastest)
2. `networkidle` with 5-second timeout as backup
3. Selector wait for `article, main, .content` containers
4. Custom function checking for loading spinners

```typescript
async function waitForArticleReady(page: Page): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  
  await Promise.race([
    page.waitForLoadState('networkidle'),
    page.waitForTimeout(5000)
  ]);
  
  await page.waitForSelector('article, main, .content, [role="article"]', { 
    state: 'visible', 
    timeout: 10000 
  }).catch(() => {});
}
```

### Anti-bot considerations

**Residential proxies** are required for heavily protected sites (Cloudflare, PerimeterX). For typical news/blog sites, datacenter proxies with proper rate limiting (1-2 requests/second per domain) usually suffice. The stealth plugin patches `navigator.webdriver`, removes `HeadlessChrome` from User-Agent, and spoofs WebGL vendor/renderer.

---

## Discovery layer: finding article URLs

### Decision tree for URL discovery

```
START: Given domain
│
├─► Check /sitemap.xml or /sitemap_index.xml
│     ├─► Found → Parse for article URLs (filter by lastmod if needed)
│     │           Use ultimate-sitemap-parser (Python) or sitemapper (Node)
│     └─► 404 → Check robots.txt for Sitemap: directive
│                 ├─► Found → Parse declared sitemap
│                 └─► Not found → Continue to RSS
│
├─► Attempt RSS/Atom feed discovery
│     ├─► Check <link rel="alternate" type="application/rss+xml">
│     ├─► Probe /feed, /rss, /rss.xml, /atom.xml
│     └─► Found → Parse for article URLs (typically 10-50 recent posts)
│
└─► Intelligent link following (fallback)
      ├─► Parse homepage for /blog/, /news/, /articles/ sections
      ├─► Identify article listing patterns (repeated article containers)
      ├─► Follow pagination links (rel="next", /page/2/)
      └─► Apply URL classification heuristics
```

### Sitemap parsing implementation

```python
from usp.tree import sitemap_tree_for_homepage

def discover_articles_from_sitemap(domain: str, limit: int = 10) -> list[str]:
    tree = sitemap_tree_for_homepage(f'https://{domain}/')
    
    article_urls = []
    for page in tree.all_pages():
        if is_article_url(page.url):
            article_urls.append(page.url)
            if len(article_urls) >= limit:
                break
    
    return article_urls
```

### URL classification heuristics

Article URLs typically contain date patterns or path segments like `/article/`, `/post/`, `/blog/`:

```typescript
const ARTICLE_PATTERNS = [
  /\/\d{4}\/\d{1,2}(\/\d{1,2})?\/[\w-]+/,  // /2025/01/09/slug
  /\/(article|post|blog|news|story)\/[\w-]+/,
  /\/\d+-[\w-]+$/,  // /12345-article-title
];

const EXCLUDE_PATTERNS = [
  /\/(tag|category|author|archive|search|login|page)(\/|$)/,
  /[?&](sort|filter|page)=/,
  /\.(css|js|jpg|png|pdf)$/i,
];

function classifyUrl(url: string): 'article' | 'listing' | 'exclude' {
  const path = new URL(url).pathname;
  
  for (const pattern of EXCLUDE_PATTERNS) {
    if (pattern.test(path)) return 'exclude';
  }
  
  for (const pattern of ARTICLE_PATTERNS) {
    if (pattern.test(path)) return 'article';
  }
  
  return 'listing';
}
```

---

## Content extraction layer

### Multi-library extraction pipeline

**Trafilatura achieves the best F1 score (0.894)** in benchmarks, with Readability.js as an excellent secondary option. The optimal approach chains multiple extractors:

```python
import trafilatura
from readability import Document

def extract_article(html: str, url: str) -> dict | None:
    # Primary: Trafilatura (best overall)
    result = trafilatura.extract(
        html,
        include_comments=False,
        include_tables=True,
        favor_precision=True,
        url=url,
        output_format='json'
    )
    
    if result and len(result.get('text', '')) > 300:
        return {'title': result.get('title'), 'body': result.get('text')}
    
    # Fallback: Readability
    doc = Document(html)
    if doc.summary() and len(doc.summary()) > 500:
        return {'title': doc.title(), 'body': strip_html(doc.summary())}
    
    return None  # Trigger LLM fallback
```

### Title extraction priority

Extract titles using this priority order for best results:

1. **JSON-LD** `headline` property (most structured)
2. **`og:title`** meta tag (Open Graph, often clean)
3. **`<h1>`** inside `<article>` or `<main>`
4. **`<title>`** tag (may include site name suffix)

```typescript
function extractTitle(doc: Document): string {
  // JSON-LD
  const jsonLd = doc.querySelector('script[type="application/ld+json"]');
  if (jsonLd) {
    const data = JSON.parse(jsonLd.textContent);
    if (data.headline) return cleanTitle(data.headline);
  }
  
  // Open Graph
  const ogTitle = doc.querySelector('meta[property="og:title"]')?.content;
  if (ogTitle) return cleanTitle(ogTitle);
  
  // H1 in article context
  const h1 = doc.querySelector('article h1, main h1')?.textContent;
  if (h1) return cleanTitle(h1);
  
  return cleanTitle(doc.title || 'Untitled');
}

function cleanTitle(title: string): string {
  // Remove site name suffixes
  const separators = [' | ', ' - ', ' :: ', ' – '];
  for (const sep of separators) {
    const parts = title.split(sep);
    if (parts.length > 1) {
      return parts.reduce((a, b) => a.length > b.length ? a : b).trim();
    }
  }
  return title.trim();
}
```

### Extraction library comparison

| Library | Precision | Recall | F1 | Best For |
|---------|-----------|--------|-----|----------|
| **Trafilatura** | 0.89 | 0.90 | **0.894** | General articles, news |
| **goose3** | **0.94** | 0.76 | 0.840 | High-precision requirements |
| **Readability.js** | 0.87 | 0.88 | 0.872 | Browser-rendered pages |
| **newspaper4k** | 0.84 | 0.79 | 0.815 | With NLP features needed |

---

## LLM integration for edge cases

### When to use LLM extraction

LLMs should be a **fallback, not primary method** due to cost and latency:

```
Traditional extraction succeeded (>500 chars)?
├─► Yes → Use heuristic result
└─► No → Check confidence score
        ├─► Above threshold → Accept shorter result
        └─► Below threshold → LLM extraction
```

### HTML preprocessing before LLM

**Convert HTML to Markdown first**—this reduces tokens by 70-90%:

```python
from bs4 import BeautifulSoup
import html2text

def preprocess_for_llm(html: str) -> str:
    soup = BeautifulSoup(html, 'html.parser')
    
    # Remove non-content elements
    for tag in soup(['script', 'style', 'nav', 'footer', 'header', 'aside']):
        tag.decompose()
    
    h2t = html2text.HTML2Text()
    h2t.ignore_images = True
    h2t.body_width = 0
    
    return h2t.handle(str(soup))
```

### Structured extraction with OpenAI

```python
from openai import OpenAI
from pydantic import BaseModel

class Article(BaseModel):
    title: str
    body: str

client = OpenAI()

response = client.chat.completions.create(
    model="gpt-4o-mini",
    response_format={"type": "json_schema", "json_schema": {
        "name": "article",
        "strict": True,
        "schema": Article.model_json_schema()
    }},
    messages=[
        {"role": "system", "content": "Extract the article title and body text."},
        {"role": "user", "content": markdown_content[:8000]}  # Context limit
    ]
)
```

**Cost estimate**: GPT-4o-mini at ~$0.15/1M input tokens means ~$0.0005 per article extraction—negligible as a fallback.

---

## Existing solutions worth considering

Before building custom, evaluate these alternatives:

| Solution | Best For | Pricing |
|----------|----------|---------|
| **Jina Reader** | Quick prototyping, `r.jina.ai/{url}` | Free tier available |
| **Firecrawl** | Full pipeline with LLM-ready output | Self-host or API |
| **Diffbot** | Diverse sites without custom rules | Token-based |
| **Crawl4AI** | Open source, pattern-learning | Free |

**Jina Reader** is the simplest starting point—prefix any URL with `https://r.jina.ai/` to get Markdown output. For production systems requiring control and scale, self-hosted Firecrawl or custom Playwright + Trafilatura provides the best balance.

---

## Pipeline architecture design

### Recommended data flow

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  Discovery  │───►│    Fetch    │───►│   Extract   │───►│   Output    │
│   Queue     │    │   Workers   │    │   Workers   │    │  [{title,   │
│  (BullMQ)   │    │ (Playwright)│    │(Trafilatura)│    │   body}]    │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
       │                 │                  │
       └── Redis ────────┴─── S3 (raw HTML)┘
```

**Separating fetch and extract workers** enables:
- Retry extraction without re-fetching
- Independent scaling (extraction is CPU-bound, fetching is I/O-bound)
- Raw HTML caching for re-processing with improved extractors

### Error handling with circuit breakers

Implement per-domain circuit breakers to prevent cascading failures:

```typescript
class DomainCircuitBreaker {
  private failures = new Map<string, number>();
  private state = new Map<string, 'CLOSED' | 'OPEN' | 'HALF_OPEN'>();
  private readonly threshold = 5;
  private readonly timeout = 300000; // 5 minutes
  
  async execute<T>(domain: string, op: () => Promise<T>): Promise<T> {
    if (this.state.get(domain) === 'OPEN') {
      throw new Error(`Circuit open for ${domain}`);
    }
    
    try {
      const result = await op();
      this.failures.set(domain, 0);
      this.state.set(domain, 'CLOSED');
      return result;
    } catch (error) {
      const count = (this.failures.get(domain) || 0) + 1;
      this.failures.set(domain, count);
      
      if (count >= this.threshold) {
        this.state.set(domain, 'OPEN');
        setTimeout(() => this.state.set(domain, 'HALF_OPEN'), this.timeout);
      }
      throw error;
    }
  }
}
```

### Job queue configuration

```typescript
import { Queue, Worker } from 'bullmq';

const scrapeQueue = new Queue('article-scraper', { connection: redis });

// Add job with retry configuration
await scrapeQueue.add('scrape', 
  { url, domain },
  { 
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    priority: 1,
    removeOnComplete: 1000
  }
);

// Worker with rate limiting
const worker = new Worker('article-scraper', processJob, {
  connection: redis,
  concurrency: 10,
  limiter: { max: 1, duration: 1000 }  // 1 req/sec per queue
});
```

---

## Complete implementation for extracting 10 articles

### Main orchestration

```typescript
interface Article {
  title: string;
  body: string;
}

async function extractArticles(domain: string, count: number = 10): Promise<Article[]> {
  const browser = await createBrowser();
  
  try {
    // 1. Discover article URLs
    const urls = await discoverArticleUrls(domain, count);
    
    // 2. Fetch and extract each article
    const articles: Article[] = [];
    
    for (const url of urls.slice(0, count)) {
      const page = await browser.newPage();
      await configurePageForScraping(page);
      
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await waitForContent(page);
        
        const html = await page.content();
        const article = await extractArticle(html, url);
        
        if (article && article.body.length > 100) {
          articles.push(article);
        }
      } finally {
        await page.close();
      }
      
      // Politeness delay
      await sleep(1000 + Math.random() * 1000);
    }
    
    return articles;
  } finally {
    await browser.close();
  }
}
```

### Output format

```typescript
// Final output: array of {title, body} plaintext objects
const result: Article[] = [
  {
    title: "How We Built Our Search Infrastructure",
    body: "When we started scaling our search system in 2023, we faced three major challenges..."
  },
  {
    title: "Understanding Vector Databases",
    body: "Vector databases have become essential for modern AI applications..."
  }
  // ... 8 more articles
];
```

---

## Key decision framework

### Browser selection
- **Playwright**: Default choice for cross-browser support and auto-waiting
- **Puppeteer + Stealth**: When anti-detection is paramount (Cloudflare-protected sites)
- **Plain HTTP**: Only for static HTML sites without JavaScript

### Extraction method
- **Trafilatura**: First choice for all article extraction
- **Readability.js**: When browser DOM is already available
- **LLM (GPT-4o-mini)**: Fallback when heuristics fail (<5% of cases)

### Discovery strategy
- **Sitemap**: Always try first (fastest, most complete)
- **RSS/Atom**: Excellent for recent articles
- **Link following**: Fallback for sites without feeds

### Infrastructure
- **Small scale (<100 articles/day)**: Single Node.js process
- **Medium scale (100-10K/day)**: BullMQ + Redis + 3-5 workers
- **Large scale (>10K/day)**: Kubernetes with auto-scaling workers

The combination of Playwright for rendering, Trafilatura for extraction, and BullMQ for orchestration provides a battle-tested foundation that handles the vast majority of public websites while remaining maintainable and cost-effective.
