'use strict';

// Extracted from src/config/feeds-seed.ts — RSS feed URLs per variant.
// Use 'en' URL when feed has multi-lang object.

const FULL_FEEDS = {
  politics: [
    { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
    { name: 'Guardian World', url: 'https://www.theguardian.com/world/rss' },
    { name: 'Reuters World', url: 'https://news.google.com/rss/search?q=site:reuters.com+world&hl=en-US&gl=US&ceid=US:en' },
  ],
  us: [
    { name: 'NPR News', url: 'https://feeds.npr.org/1001/rss.xml' },
    { name: 'Politico', url: 'https://news.google.com/rss/search?q=site:politico.com+when:1d&hl=en-US&gl=US&ceid=US:en' },
  ],
  europe: [
    { name: 'France 24', url: 'https://www.france24.com/en/rss' },
    { name: 'EuroNews', url: 'https://www.euronews.com/rss?format=xml' },
    { name: 'DW News', url: 'https://rss.dw.com/xml/rss-en-all' },
  ],
  tech: [
    { name: 'Hacker News', url: 'https://hnrss.org/frontpage' },
    { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/technology-lab' },
    { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
  ],
  finance: [
    { name: 'CNBC', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
    { name: 'Reuters Business', url: 'https://news.google.com/rss/search?q=site:reuters.com+business+markets&hl=en-US&gl=US&ceid=US:en' },
  ],
  gov: [
    { name: 'UN News', url: 'https://news.un.org/feed/subscribe/en/news/all/rss.xml' },
    { name: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_all.xml' },
  ],
};

const TECH_FEEDS = {
  tech: [
    { name: 'TechCrunch', url: 'https://techcrunch.com/feed/' },
    { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
    { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/technology-lab' },
    { name: 'Hacker News', url: 'https://hnrss.org/frontpage' },
    { name: 'MIT Tech Review', url: 'https://www.technologyreview.com/feed/' },
  ],
  ai: [
    { name: 'AI News', url: 'https://news.google.com/rss/search?q=(OpenAI+OR+Anthropic+OR+ChatGPT)+when:2d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'VentureBeat AI', url: 'https://venturebeat.com/category/ai/feed/' },
    { name: 'The Verge AI', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml' },
  ],
};

const FINANCE_FEEDS = {
  markets: [
    { name: 'CNBC', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
    { name: 'MarketWatch', url: 'https://news.google.com/rss/search?q=site:marketwatch.com+markets+when:1d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'Yahoo Finance', url: 'https://finance.yahoo.com/rss/topstories' },
    { name: 'Reuters Markets', url: 'https://news.google.com/rss/search?q=site:reuters.com+markets+stocks+when:1d&hl=en-US&gl=US&ceid=US:en' },
  ],
  centralbanks: [
    { name: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_all.xml' },
  ],
};

const HAPPY_FEEDS = {
  positive: [
    { name: 'Good News Network', url: 'https://www.goodnewsnetwork.org/feed/' },
    { name: 'Positive.News', url: 'https://www.positive.news/feed/' },
    { name: 'Reasons to be Cheerful', url: 'https://reasonstobecheerful.world/feed/' },
    { name: 'Optimist Daily', url: 'https://www.optimistdaily.com/feed/' },
  ],
  science: [
    { name: 'GNN Science', url: 'https://www.goodnewsnetwork.org/category/news/science/feed/' },
    { name: 'Nature News', url: 'https://feeds.nature.com/nature/rss/current' },
    { name: 'New Scientist', url: 'https://www.newscientist.com/feed/home/' },
  ],
};

module.exports = { FULL_FEEDS, TECH_FEEDS, FINANCE_FEEDS, HAPPY_FEEDS };
