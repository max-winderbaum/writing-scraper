#!/usr/bin/env node

import { extractArticlesFromSite } from './index.js';

function printUsage(): void {
  console.log(`
Usage: writing-scraper <url> [options]

Extract articles from a website and output as JSON.

Arguments:
  url              The website URL to scrape (e.g., https://example.com)

Options:
  -n, --count      Number of articles to extract (default: 10)
  -o, --output     Output file path (default: stdout)
  -q, --quiet      Suppress progress output
  -h, --help       Show this help message

Examples:
  writing-scraper https://heidisingfield.substack.com
  writing-scraper https://example.com/blog -n 5
  writing-scraper https://example.com -o articles.json -q
`);
}

function parseArgs(args: string[]): {
  url: string | null;
  count: number;
  output: string | null;
  quiet: boolean;
  help: boolean;
} {
  const result = {
    url: null as string | null,
    count: 10,
    output: null as string | null,
    quiet: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '-h' || arg === '--help') {
      result.help = true;
    } else if (arg === '-q' || arg === '--quiet') {
      result.quiet = true;
    } else if (arg === '-n' || arg === '--count') {
      const num = parseInt(args[++i], 10);
      if (!isNaN(num) && num > 0) {
        result.count = num;
      }
    } else if (arg === '-o' || arg === '--output') {
      result.output = args[++i];
    } else if (!arg.startsWith('-') && !result.url) {
      result.url = arg;
    }
  }

  return result;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  if (options.help || !options.url) {
    printUsage();
    process.exit(options.help ? 0 : 1);
  }

  // Validate URL
  let url: URL;
  try {
    url = new URL(options.url);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('URL must use http or https protocol');
    }
  } catch (error) {
    console.error(`Invalid URL: ${options.url}`);
    process.exit(1);
  }

  try {
    const articles = await extractArticlesFromSite(url.href, {
      count: options.count,
      verbose: !options.quiet,
    });

    // Format output
    const output = JSON.stringify(articles, null, 2);

    if (options.output) {
      const fs = await import('fs');
      fs.writeFileSync(options.output, output);
      if (!options.quiet) {
        console.log(`\nOutput written to ${options.output}`);
      }
    } else {
      console.log('\n--- Articles JSON ---\n');
      console.log(output);
    }

    if (!options.quiet) {
      console.log(`\nDone! Extracted ${articles.length} articles.`);
    }
  } catch (error) {
    console.error('\nError:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
