'use strict';

// Synced with src/config/feeds-seed.ts — RSS feed URLs per variant.
// For multi-lang feeds, the 'en' URL is used (relay resolves lang at runtime from Supabase).

const FULL_FEEDS = {
  politics: [
    { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
    { name: 'Guardian World', url: 'https://www.theguardian.com/world/rss' },
    { name: 'AP News', url: 'https://news.google.com/rss/search?q=site:apnews.com&hl=en-US&gl=US&ceid=US:en' },
    { name: 'Reuters World', url: 'https://news.google.com/rss/search?q=site:reuters.com+world&hl=en-US&gl=US&ceid=US:en' },
    { name: 'CNN World', url: 'https://news.google.com/rss/search?q=site:cnn.com+world+news+when:1d&hl=en-US&gl=US&ceid=US:en' },
  ],
  us: [
    { name: 'NPR News', url: 'https://feeds.npr.org/1001/rss.xml' },
    { name: 'Politico', url: 'https://news.google.com/rss/search?q=site:politico.com+when:1d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'Axios', url: 'https://api.axios.com/feed/' },
    { name: 'Fox News', url: 'https://moxie.foxnews.com/google-publisher/us.xml' },
    { name: 'NBC News', url: 'http://feeds.nbcnews.com/feeds/topstories' },
    { name: 'CBS News', url: 'http://www.cbsnews.com/latest/rss/main' },
    { name: 'Reuters US', url: 'http://feeds.reuters.com/Reuters/domesticNews' },
    { name: 'Bloomberg US', url: 'https://news.google.com/rss/search?q=site:bloomberg.com+US+when:1d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'ABC News', url: 'https://abcnews.go.com/abcnews/topstories' },
    { name: 'USA Today', url: 'https://www.usatoday.com/rss/' },
    { name: 'The Hill', url: 'https://thehill.com/feed/' },
    { name: 'Washington Post', url: 'https://news.google.com/rss/search?q=site:washingtonpost.com+when:1d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'New York Times', url: 'https://news.google.com/rss/search?q=site:nytimes.com+when:1d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'ProPublica', url: 'https://feeds.propublica.org/propublica/main' },
  ],
  europe: [
    { name: 'France 24', url: 'https://www.france24.com/en/rss' },
    { name: 'EuroNews', url: 'https://www.euronews.com/rss?format=xml' },
    { name: 'Le Monde', url: 'https://www.lemonde.fr/en/rss/une.xml' },
    { name: 'DW News', url: 'https://rss.dw.com/xml/rss-en-all' },
  ],
  middleeast: [
    { name: 'BBC Middle East', url: 'https://feeds.bbci.co.uk/news/world/middle_east/rss.xml' },
    { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml' },
    { name: 'Al Arabiya', url: 'https://news.google.com/rss/search?q=site:english.alarabiya.net+when:2d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'Guardian ME', url: 'https://www.theguardian.com/world/middleeast/rss' },
    { name: 'Iran International', url: 'https://news.google.com/rss/search?q=site:iranintl.com+when:2d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'Haaretz', url: 'https://news.google.com/rss/search?q=site:haaretz.com+when:7d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'The National', url: 'https://news.google.com/rss/search?q=site:thenationalnews.com+when:2d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'Asharq Business', url: 'https://asharqbusiness.com/rss.xml' },
  ],
  tech: [
    { name: 'Hacker News', url: 'https://hnrss.org/frontpage' },
    { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/technology-lab' },
    { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
    { name: 'MIT Tech Review', url: 'https://www.technologyreview.com/feed/' },
  ],
  ai: [
    { name: 'AI News', url: 'https://news.google.com/rss/search?q=(OpenAI+OR+Anthropic+OR+Google+AI+OR+"large+language+model"+OR+ChatGPT)+when:2d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'VentureBeat AI', url: 'https://venturebeat.com/category/ai/feed/' },
    { name: 'The Verge AI', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml' },
    { name: 'MIT Tech Review', url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed' },
    { name: 'ArXiv AI', url: 'https://export.arxiv.org/rss/cs.AI' },
  ],
  finance: [
    { name: 'CNBC', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
    { name: 'MarketWatch', url: 'https://news.google.com/rss/search?q=site:marketwatch.com+markets+when:1d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'Yahoo Finance', url: 'https://finance.yahoo.com/news/rssindex' },
    { name: 'Financial Times', url: 'https://www.ft.com/rss/home' },
    { name: 'Reuters Business', url: 'https://news.google.com/rss/search?q=site:reuters.com+business+markets&hl=en-US&gl=US&ceid=US:en' },
  ],
  gov: [
    { name: 'White House', url: 'https://news.google.com/rss/search?q=site:whitehouse.gov&hl=en-US&gl=US&ceid=US:en' },
    { name: 'State Dept', url: 'https://news.google.com/rss/search?q=site:state.gov+OR+"State+Department"&hl=en-US&gl=US&ceid=US:en' },
    { name: 'Pentagon', url: 'https://news.google.com/rss/search?q=site:defense.gov+OR+Pentagon&hl=en-US&gl=US&ceid=US:en' },
    { name: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_all.xml' },
    { name: 'UN News', url: 'https://news.un.org/feed/subscribe/en/news/all/rss.xml' },
    { name: 'CISA', url: 'https://www.cisa.gov/cybersecurity-advisories/all.xml' },
  ],
  intel: [
    { name: 'Defense One', url: 'https://www.defenseone.com/rss/all/' },
    { name: 'Breaking Defense', url: 'https://breakingdefense.com/feed/' },
    { name: 'The War Zone', url: 'https://www.twz.com/feed' },
    { name: 'Defense News', url: 'https://www.defensenews.com/arc/outboundfeeds/rss/?outputType=xml' },
    { name: 'Military Times', url: 'https://www.militarytimes.com/arc/outboundfeeds/rss/?outputType=xml' },
    { name: 'USNI News', url: 'https://news.usni.org/feed' },
    { name: 'Bellingcat', url: 'https://news.google.com/rss/search?q=site:bellingcat.com+when:30d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'Krebs Security', url: 'https://krebsonsecurity.com/feed/' },
  ],
  layoffs: [
    { name: 'Layoffs.fyi', url: 'https://news.google.com/rss/search?q=tech+company+layoffs+announced&hl=en&gl=US&ceid=US:en' },
    { name: 'TechCrunch Layoffs', url: 'https://techcrunch.com/tag/layoffs/feed/' },
    { name: 'Layoffs News', url: 'https://news.google.com/rss/search?q=(layoffs+OR+"job+cuts"+OR+"workforce+reduction")+when:3d&hl=en-US&gl=US&ceid=US:en' },
  ],
  thinktanks: [
    { name: 'Foreign Policy', url: 'https://foreignpolicy.com/feed/' },
    { name: 'Atlantic Council', url: 'https://www.atlanticcouncil.org/feed/' },
    { name: 'Foreign Affairs', url: 'https://www.foreignaffairs.com/rss.xml' },
    { name: 'CSIS', url: 'https://news.google.com/rss/search?q=site:csis.org+when:7d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'RAND', url: 'https://news.google.com/rss/search?q=site:rand.org+when:7d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'Brookings', url: 'https://news.google.com/rss/search?q=site:brookings.edu+when:7d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'Carnegie', url: 'https://news.google.com/rss/search?q=site:carnegieendowment.org+when:7d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'War on the Rocks', url: 'https://warontherocks.com/feed' },
  ],
  crisis: [
    { name: 'CrisisWatch', url: 'https://www.crisisgroup.org/rss' },
    { name: 'IAEA', url: 'https://www.iaea.org/feeds/topnews' },
    { name: 'WHO', url: 'https://www.who.int/rss-feeds/news-english.xml' },
    { name: 'UNHCR', url: 'https://news.google.com/rss/search?q=site:unhcr.org+OR+UNHCR+refugees+when:3d&hl=en-US&gl=US&ceid=US:en' },
  ],
  africa: [
    { name: 'Africa News', url: 'https://news.google.com/rss/search?q=(Africa+OR+Nigeria+OR+Kenya+OR+"South+Africa"+OR+Ethiopia)+when:2d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'Sahel Crisis', url: 'https://news.google.com/rss/search?q=(Sahel+OR+Mali+OR+Niger+OR+"Burkina+Faso"+OR+Wagner)+when:3d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'News24', url: 'https://feeds.news24.com/articles/news24/TopStories/rss' },
    { name: 'BBC Africa', url: 'https://feeds.bbci.co.uk/news/world/africa/rss.xml' },
    { name: 'Africanews', url: 'https://www.africanews.com/feed/rss' },
    { name: 'Premium Times', url: 'https://www.premiumtimesng.com/feed' },
    { name: 'Channels TV', url: 'https://www.channelstv.com/feed/' },
  ],
  latam: [
    { name: 'Latin America', url: 'https://news.google.com/rss/search?q=(Brazil+OR+Mexico+OR+Argentina+OR+Venezuela+OR+Colombia)+when:2d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'BBC Latin America', url: 'https://feeds.bbci.co.uk/news/world/latin_america/rss.xml' },
    { name: 'Reuters LatAm', url: 'https://news.google.com/rss/search?q=site:reuters.com+(Brazil+OR+Mexico+OR+Argentina)+when:3d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'Guardian Americas', url: 'https://www.theguardian.com/world/americas/rss' },
    { name: 'InSight Crime', url: 'https://insightcrime.org/feed/' },
    { name: 'Mexico News Daily', url: 'https://mexiconewsdaily.com/feed/' },
    { name: 'France 24 LatAm', url: 'https://www.france24.com/en/americas/rss' },
  ],
  asia: [
    { name: 'Asia News', url: 'https://news.google.com/rss/search?q=(China+OR+Japan+OR+Korea+OR+India+OR+ASEAN)+when:2d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'BBC Asia', url: 'https://feeds.bbci.co.uk/news/world/asia/rss.xml' },
    { name: 'The Diplomat', url: 'https://thediplomat.com/feed/' },
    { name: 'South China Morning Post', url: 'https://www.scmp.com/rss/91/feed/' },
    { name: 'Reuters Asia', url: 'https://news.google.com/rss/search?q=site:reuters.com+(China+OR+Japan+OR+Taiwan+OR+Korea)+when:3d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'Nikkei Asia', url: 'https://news.google.com/rss/search?q=site:asia.nikkei.com+when:3d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'CNA', url: 'https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml' },
    { name: 'The Hindu', url: 'https://www.thehindu.com/news/national/feeder/default.rss' },
    { name: 'NDTV', url: 'https://feeds.feedburner.com/ndtvnews-top-stories' },
  ],
  energy: [
    { name: 'Oil & Gas', url: 'https://news.google.com/rss/search?q=(oil+price+OR+OPEC+OR+"natural+gas"+OR+pipeline+OR+LNG)+when:2d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'Nuclear Energy', url: 'https://news.google.com/rss/search?q=("nuclear+energy"+OR+"nuclear+power"+OR+uranium+OR+IAEA)+when:3d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'Reuters Energy', url: 'https://news.google.com/rss/search?q=site:reuters.com+(oil+OR+gas+OR+energy+OR+OPEC)+when:3d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'Mining & Resources', url: 'https://news.google.com/rss/search?q=(lithium+OR+"rare+earth"+OR+cobalt+OR+mining)+when:3d&hl=en-US&gl=US&ceid=US:en' },
  ],
};

const TECH_FEEDS = {
  tech: [
    { name: 'TechCrunch', url: 'https://techcrunch.com/feed/' },
    { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
    { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/technology-lab' },
    { name: 'Hacker News', url: 'https://hnrss.org/frontpage' },
    { name: 'MIT Tech Review', url: 'https://www.technologyreview.com/feed/' },
    { name: 'ZDNet', url: 'https://www.zdnet.com/news/rss.xml' },
    { name: 'TechMeme', url: 'https://www.techmeme.com/feed.xml' },
    { name: 'Engadget', url: 'https://www.engadget.com/rss.xml' },
    { name: 'Fast Company', url: 'https://feeds.feedburner.com/fastcompany/headlines' },
  ],
  ai: [
    { name: 'AI News', url: 'https://news.google.com/rss/search?q=(OpenAI+OR+Anthropic+OR+Google+AI+OR+"large+language+model"+OR+ChatGPT+OR+Claude+OR+"AI+model")+when:2d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'VentureBeat AI', url: 'https://venturebeat.com/category/ai/feed/' },
    { name: 'The Verge AI', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml' },
    { name: 'MIT Tech Review AI', url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed' },
    { name: 'ArXiv AI', url: 'https://export.arxiv.org/rss/cs.AI' },
    { name: 'ArXiv ML', url: 'https://export.arxiv.org/rss/cs.LG' },
  ],
  startups: [
    { name: 'TechCrunch Startups', url: 'https://techcrunch.com/category/startups/feed/' },
    { name: 'VentureBeat', url: 'https://venturebeat.com/feed/' },
    { name: 'Crunchbase News', url: 'https://news.crunchbase.com/feed/' },
    { name: 'SaaStr', url: 'https://www.saastr.com/feed/' },
  ],
  vcblogs: [
    { name: 'Y Combinator Blog', url: 'https://www.ycombinator.com/blog/rss/' },
    { name: 'Stratechery', url: 'https://stratechery.com/feed/' },
    { name: "Lenny's Newsletter", url: 'https://www.lennysnewsletter.com/feed' },
  ],
  regionalStartups: [
    { name: 'EU Startups', url: 'https://news.google.com/rss/search?q=site:eu-startups.com+when:7d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'Tech.eu', url: 'https://tech.eu/feed/' },
    { name: 'Sifted (Europe)', url: 'https://sifted.eu/feed' },
    { name: 'Inc42 (India)', url: 'https://inc42.com/feed/' },
    { name: 'TechCabal (Africa)', url: 'https://techcabal.com/feed/' },
  ],
  github: [
    { name: 'GitHub Blog', url: 'https://github.blog/feed/' },
    { name: 'GitHub Trending', url: 'https://mshibanami.github.io/GitHubTrendingRSS/daily/all.xml' },
    { name: 'Show HN', url: 'https://hnrss.org/show' },
  ],
  ipo: [
    { name: 'IPO News', url: 'https://news.google.com/rss/search?q=(IPO+OR+"initial+public+offering"+OR+SPAC)+tech+when:7d&hl=en-US&gl=US&ceid=US:en' },
  ],
  funding: [
    { name: 'VC News', url: 'https://news.google.com/rss/search?q=("Series+A"+OR+"Series+B"+OR+"Series+C"+OR+"funding+round"+OR+"venture+capital")+when:7d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'Startup Funding', url: 'https://news.google.com/rss/search?q=("startup+funding"+OR+"raised+funding"+OR+"raised+$"+OR+"funding+announced")+when:7d&hl=en-US&gl=US&ceid=US:en' },
  ],
  producthunt: [
    { name: 'Product Hunt', url: 'https://www.producthunt.com/feed' },
  ],
  outages: [
    { name: 'AWS Status', url: 'https://news.google.com/rss/search?q=AWS+outage+OR+"Amazon+Web+Services"+down+when:1d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'Cloud Outages', url: 'https://news.google.com/rss/search?q=(Azure+OR+GCP+OR+Cloudflare+OR+Slack+OR+GitHub)+outage+OR+down+when:1d&hl=en-US&gl=US&ceid=US:en' },
  ],
  security: [
    { name: 'Krebs Security', url: 'https://krebsonsecurity.com/feed/' },
    { name: 'The Hacker News', url: 'https://feeds.feedburner.com/TheHackersNews' },
    { name: 'Dark Reading', url: 'https://www.darkreading.com/rss.xml' },
    { name: 'Schneier', url: 'https://www.schneier.com/feed/' },
  ],
  policy: [
    { name: 'Politico Tech', url: 'https://rss.politico.com/technology.xml' },
    { name: 'AI Regulation', url: 'https://news.google.com/rss/search?q=AI+regulation+OR+"artificial+intelligence"+law+OR+policy+when:7d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'EFF News', url: 'https://news.google.com/rss/search?q=site:eff.org+OR+"Electronic+Frontier+Foundation"+when:14d&hl=en-US&gl=US&ceid=US:en' },
  ],
  thinktanks: [
    { name: 'Brookings Tech', url: 'https://news.google.com/rss/search?q=site:brookings.edu+technology+OR+AI+when:14d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'CSIS Tech', url: 'https://news.google.com/rss/search?q=site:csis.org+technology+OR+AI+when:14d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'Stanford HAI', url: 'https://news.google.com/rss/search?q=site:hai.stanford.edu+when:14d&hl=en-US&gl=US&ceid=US:en' },
  ],
  finance: [
    { name: 'CNBC Tech', url: 'https://www.cnbc.com/id/19854910/device/rss/rss.html' },
    { name: 'Yahoo Finance', url: 'https://finance.yahoo.com/rss/topstories' },
  ],
  hardware: [
    { name: "Tom's Hardware", url: 'https://www.tomshardware.com/feeds/all' },
    { name: 'Semiconductor News', url: 'https://news.google.com/rss/search?q=semiconductor+OR+chip+OR+TSMC+OR+NVIDIA+OR+Intel+when:3d&hl=en-US&gl=US&ceid=US:en' },
  ],
  cloud: [
    { name: 'InfoQ', url: 'https://feed.infoq.com/' },
    { name: 'The New Stack', url: 'https://thenewstack.io/feed/' },
    { name: 'DevOps.com', url: 'https://devops.com/feed/' },
  ],
  dev: [
    { name: 'Dev.to', url: 'https://dev.to/feed' },
    { name: 'Lobsters', url: 'https://lobste.rs/rss' },
    { name: 'Changelog', url: 'https://changelog.com/feed' },
  ],
  layoffs: [
    { name: 'Layoffs.fyi', url: 'https://news.google.com/rss/search?q=tech+layoffs+when:7d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'TechCrunch Layoffs', url: 'https://techcrunch.com/tag/layoffs/feed/' },
  ],
  unicorns: [
    { name: 'Unicorn News', url: 'https://news.google.com/rss/search?q=("unicorn+startup"+OR+"unicorn+valuation"+OR+"$1+billion+valuation")+when:7d&hl=en-US&gl=US&ceid=US:en' },
  ],
  accelerators: [
    { name: 'Techstars News', url: 'https://news.google.com/rss/search?q=Techstars+accelerator+when:14d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'Demo Day News', url: 'https://news.google.com/rss/search?q=("demo+day"+OR+"YC+batch"+OR+"accelerator+batch")+startup+when:7d&hl=en-US&gl=US&ceid=US:en' },
  ],
  podcasts: [
    { name: 'All-In Podcast', url: 'https://news.google.com/rss/search?q="All-In+podcast"+(Chamath+OR+Sacks+OR+Friedberg)+when:7d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'Pivot Podcast', url: 'https://feeds.megaphone.fm/pivot' },
    { name: '20VC Episodes', url: 'https://rss.libsyn.com/shows/61840/destinations/240976.xml' },
    { name: 'Masters of Scale', url: 'https://rss.art19.com/masters-of-scale' },
  ],
};

const FINANCE_FEEDS = {
  markets: [
    { name: 'CNBC', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
    { name: 'MarketWatch', url: 'https://news.google.com/rss/search?q=site:marketwatch.com+markets+when:1d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'Yahoo Finance', url: 'https://finance.yahoo.com/rss/topstories' },
    { name: 'Seeking Alpha', url: 'https://seekingalpha.com/market_currents.xml' },
    { name: 'Reuters Markets', url: 'https://news.google.com/rss/search?q=site:reuters.com+markets+stocks+when:1d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'Bloomberg Markets', url: 'https://news.google.com/rss/search?q=site:bloomberg.com+markets+when:1d&hl=en-US&gl=US&ceid=US:en' },
  ],
  forex: [
    { name: 'Forex News', url: 'https://news.google.com/rss/search?q=("forex"+OR+"currency"+OR+"FX+market")+trading+when:1d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'Dollar Watch', url: 'https://news.google.com/rss/search?q=("dollar+index"+OR+DXY+OR+"US+dollar"+OR+"euro+dollar")+when:2d&hl=en-US&gl=US&ceid=US:en' },
  ],
  bonds: [
    { name: 'Bond Market', url: 'https://news.google.com/rss/search?q=("bond+market"+OR+"treasury+yields"+OR+"bond+yields"+OR+"fixed+income")+when:2d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'Treasury Watch', url: 'https://news.google.com/rss/search?q=("US+Treasury"+OR+"Treasury+auction"+OR+"10-year+yield"+OR+"2-year+yield")+when:2d&hl=en-US&gl=US&ceid=US:en' },
  ],
  commodities: [
    { name: 'Oil & Gas', url: 'https://news.google.com/rss/search?q=(oil+price+OR+OPEC+OR+"natural+gas"+OR+"crude+oil"+OR+WTI+OR+Brent)+when:1d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'Gold & Metals', url: 'https://news.google.com/rss/search?q=(gold+price+OR+silver+price+OR+copper+OR+platinum+OR+"precious+metals")+when:2d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'Agriculture', url: 'https://news.google.com/rss/search?q=(wheat+OR+corn+OR+soybeans+OR+coffee+OR+sugar)+price+OR+commodity+when:3d&hl=en-US&gl=US&ceid=US:en' },
  ],
  crypto: [
    { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
    { name: 'Cointelegraph', url: 'https://cointelegraph.com/rss' },
    { name: 'Crypto News', url: 'https://news.google.com/rss/search?q=(bitcoin+OR+ethereum+OR+crypto+OR+"digital+assets")+when:1d&hl=en-US&gl=US&ceid=US:en' },
  ],
  centralbanks: [
    { name: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_all.xml' },
    { name: 'ECB Watch', url: 'https://news.google.com/rss/search?q=("European+Central+Bank"+OR+ECB+OR+Lagarde)+monetary+policy+when:3d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'Global Central Banks', url: 'https://news.google.com/rss/search?q=("rate+hike"+OR+"rate+cut"+OR+"interest+rate+decision")+central+bank+when:3d&hl=en-US&gl=US&ceid=US:en' },
  ],
  economic: [
    { name: 'Economic Data', url: 'https://news.google.com/rss/search?q=(CPI+OR+inflation+OR+GDP+OR+"jobs+report"+OR+"nonfarm+payrolls"+OR+PMI)+when:2d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'Trade & Tariffs', url: 'https://news.google.com/rss/search?q=(tariff+OR+"trade+war"+OR+"trade+deficit"+OR+sanctions)+when:2d&hl=en-US&gl=US&ceid=US:en' },
  ],
  ipo: [
    { name: 'IPO News', url: 'https://news.google.com/rss/search?q=(IPO+OR+"initial+public+offering"+OR+SPAC+OR+"direct+listing")+when:3d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'Earnings Reports', url: 'https://news.google.com/rss/search?q=("earnings+report"+OR+"quarterly+earnings"+OR+"revenue+beat"+OR+"earnings+miss")+when:2d&hl=en-US&gl=US&ceid=US:en' },
  ],
  derivatives: [
    { name: 'Options Market', url: 'https://news.google.com/rss/search?q=("options+market"+OR+"options+trading"+OR+"put+call+ratio"+OR+VIX)+when:2d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'Futures Trading', url: 'https://news.google.com/rss/search?q=("futures+trading"+OR+"S%26P+500+futures"+OR+"Nasdaq+futures")+when:1d&hl=en-US&gl=US&ceid=US:en' },
  ],
  fintech: [
    { name: 'Fintech News', url: 'https://news.google.com/rss/search?q=(fintech+OR+"payment+technology"+OR+"neobank"+OR+"digital+banking")+when:3d&hl=en-US&gl=US&ceid=US:en' },
  ],
  regulation: [
    { name: 'SEC', url: 'https://www.sec.gov/news/pressreleases.rss' },
    { name: 'Financial Regulation', url: 'https://news.google.com/rss/search?q=(SEC+OR+CFTC+OR+FINRA+OR+FCA)+regulation+OR+enforcement+when:3d&hl=en-US&gl=US&ceid=US:en' },
  ],
  institutional: [
    { name: 'Hedge Fund News', url: 'https://news.google.com/rss/search?q=("hedge+fund"+OR+"Bridgewater"+OR+"Citadel"+OR+"Renaissance")+when:7d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'Private Equity', url: 'https://news.google.com/rss/search?q=("private+equity"+OR+Blackstone+OR+KKR+OR+Apollo+OR+Carlyle)+when:3d&hl=en-US&gl=US&ceid=US:en' },
  ],
  analysis: [
    { name: 'Market Outlook', url: 'https://news.google.com/rss/search?q=("market+outlook"+OR+"stock+market+forecast"+OR+"bull+market"+OR+"bear+market")+when:3d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'Bank Research', url: 'https://news.google.com/rss/search?q=("Goldman+Sachs"+OR+"JPMorgan"+OR+"Morgan+Stanley")+forecast+OR+outlook+when:3d&hl=en-US&gl=US&ceid=US:en' },
  ],
  gccNews: [
    { name: 'Arabian Business', url: 'https://news.google.com/rss/search?q=site:arabianbusiness.com+(Saudi+Arabia+OR+UAE+OR+GCC)+when:7d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'The National', url: 'https://news.google.com/rss/search?q=site:thenationalnews.com+(Abu+Dhabi+OR+UAE+OR+Saudi)+when:7d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'Gulf FDI', url: 'https://news.google.com/rss/search?q=(PIF+OR+"DP+World"+OR+Mubadala+OR+ADNOC+OR+Masdar+OR+"ACWA+Power")+infrastructure+when:7d&hl=en-US&gl=US&ceid=US:en' },
    { name: 'Vision 2030', url: 'https://news.google.com/rss/search?q="Vision+2030"+(project+OR+investment+OR+announced)+when:14d&hl=en-US&gl=US&ceid=US:en' },
  ],
};

const HAPPY_FEEDS = {
  positive: [
    { name: 'Good News Network', url: 'https://www.goodnewsnetwork.org/feed/' },
    { name: 'Positive.News', url: 'https://www.positive.news/feed/' },
    { name: 'Reasons to be Cheerful', url: 'https://reasonstobecheerful.world/feed/' },
    { name: 'Optimist Daily', url: 'https://www.optimistdaily.com/feed/' },
    { name: 'Upworthy', url: 'https://www.upworthy.com/feed/' },
    { name: 'DailyGood', url: 'https://www.dailygood.org/feed' },
    { name: 'Good Good Good', url: 'https://www.goodgoodgood.co/articles/rss.xml' },
    { name: 'Sunny Skyz', url: 'https://www.sunnyskyz.com/rss_tebow.php' },
    { name: 'The Better India', url: 'https://thebetterindia.com/feed/' },
  ],
  science: [
    { name: 'GNN Science', url: 'https://www.goodnewsnetwork.org/category/news/science/feed/' },
    { name: 'ScienceDaily', url: 'https://www.sciencedaily.com/rss/all.xml' },
    { name: 'Nature News', url: 'https://feeds.nature.com/nature/rss/current' },
    { name: 'New Scientist', url: 'https://www.newscientist.com/feed/home/' },
    { name: 'Singularity Hub', url: 'https://singularityhub.com/feed/' },
    { name: 'Human Progress', url: 'https://humanprogress.org/feed/' },
  ],
  nature: [
    { name: 'GNN Animals', url: 'https://www.goodnewsnetwork.org/category/news/animals/feed/' },
  ],
  health: [
    { name: 'GNN Health', url: 'https://www.goodnewsnetwork.org/category/news/health/feed/' },
  ],
  inspiring: [
    { name: 'GNN Heroes', url: 'https://www.goodnewsnetwork.org/category/news/inspiring/feed/' },
  ],
};

module.exports = { FULL_FEEDS, TECH_FEEDS, FINANCE_FEEDS, HAPPY_FEEDS };
