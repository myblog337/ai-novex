# AINOVEX — অডিট রিপোর্ট (রিভার্স ইঞ্জিনিয়ারিং + বাগ + SEO)

## ১. প্রজেক্ট কীভাবে কাজ করে
- **স্ট্যাক:** React 19 + Vite + Tailwind 4, কোনো সার্ভার/API নেই। কনটেন্ট `content/*.json` ও `content/articles/*.md` থেকে বিল্ড-টাইমে আসে।
- **বিল্ড:** `vite build` → `scripts/postbuild.mjs`। এই স্ক্রিপ্ট প্রতিটি রুটের জন্য আলাদা HTML (title, meta, canonical, JSON-LD, কনটেন্ট) + `sitemap.xml`, `rss.xml`, `robots.txt` বানায়।
- **ক্লায়েন্ট:** `src/App.tsx` হাতে-লেখা রাউটার (pushState)। `createRoot` দিয়ে prerender HTML **রিপ্লেস** হয় (hydrate নয়) — তাই prerender আর ক্লায়েন্ট DOM মিলে থাকা জরুরি, কারণ Google রেন্ডার-করা DOM-ও দেখে।
- **হোস্টিং:** Netlify (`netlify.toml`: redirect, header, 404)।

## ২. যে বাগ পাওয়া গেছে ও ঠিক করা হয়েছে
| # | সমস্যা | ফাইল | সমাধান |
|---|---|---|---|
| B1 | ইনডেক্সিং নিয়ম **দুই জায়গায়** (App.tsx ও postbuild) — আলাদা হয়ে যাওয়ার ঝুঁকি | App.tsx, postbuild | একটাই ফাইল: `src/config/indexing.js` |
| B2 | `String.replace` এ replacement-string ব্যবহার: টাইটেল/কনটেন্টে `$&`, `$'`, `$$` থাকলে HTML নষ্ট হতো | postbuild | সব replace এখন function replacer; টেস্ট করা হয়েছে |
| B3 | JSON-LD এ `</script>` এস্কেপ ছিল না | postbuild | `<` → `\u003c` |
| B4 | Related articles: prerender প্রথম ২টা নিত, ক্লায়েন্ট একই-ক্যাটেগরি আগে — দুই রকম | postbuild | দুই জায়গায় একই লজিক |
| B5 | Home prerender ৬টা টুল/সব আর্টিকেল দেখাত, ক্লায়েন্ট ৫টা ফিচার্ড/৩টা আর্টিকেল | postbuild | ক্লায়েন্টের সাথে মিলানো |
| B6 | Trending চিপ: prerender → ক্যাটেগরি লিংক, ক্লায়েন্ট → সার্চ বাটন ("SEO" চিপের কোনো মিল নেই) | Hero, HomeView | সব চিপ এখন আসল ক্যাটেগরি URL-এ যায় |
| B7 | Contact: আসল ইমেইল JS-এ হার্ডকোড, `settings.contactEmail` খালি; মেসেজে লেখা "পেজে দেখানো ঠিকানা" — পেজে কোনো ঠিকানা ছিল না | ContactView, settings.json, postbuild | ইমেইল `settings.json` থেকে, পেজে দৃশ্যমান mailto লিংক |
| B8 | ফর্ম `label` গুলো input-এর সাথে যুক্ত ছিল না | ContactView | `htmlFor`/`id` |
| B9 | Author পেজে লেখা "Sorted by update date" কিন্তু সর্ট হতো না | AuthorView, postbuild | updatedAt অনুযায়ী সর্ট |
| B10 | Search modal: বাইরে ক্লিকে বন্ধ হতো না (`stopPropagation` ছিল কিন্তু বাইরের onClick ছিল না) | SearchModal | backdrop click, `role=dialog`, aria-label |
| B11 | টুল কার্ড/সার্চ রেজাল্ট `div onClick` — কিবোর্ড দিয়ে খোলা যেত না | ToolsView, FeaturedTools, CategoryDetailView, SearchModal | `role=button`, `tabIndex`, Enter/Space |
| B12 | Header অ্যাক্টিভ লিংক `/tools/?q=…` বা `/blog/<slug>/` এ কাজ করত না | Header | normalize + child match + `aria-current`; মোবাইল মেনু Esc দিয়ে বন্ধ |
| B13 | Share বাটন: clipboard না থাকলে/রিজেক্ট হলে unhandled error, তবু "Copied" দেখাত | ArticleDetailView | try/catch + fallback |
| B14 | `animate-in fade-in …` ক্লাসগুলো কোনো কাজ করত না (tailwindcss-animate ইনস্টল নেই) | index.css | ছোট নিজস্ব keyframes |
| B15 | `/images/articles/*` ও `*.webp` ফাইলনেম hash নেই, তবু `immutable` ১ বছর ক্যাশ — ছবি বদলালে পুরনোটাই থাকত | netlify.toml | ৩০ দিন + stale-while-revalidate |
| B16 | আর্টিকেল ছবির `width/height` সবসময় 1200×675 লেখা, আসল ছবি 1200×800/855/901/912 | postbuild | আসল সাইজ পড়া হয় |

## ৩. SEO সমস্যা ও সমাধান
| # | সমস্যা | সমাধান |
|---|---|---|
| S1 | **Home, /blog/, /tools/, /categories/, /about/, /contact/, author — সবই `noindex`।** ব্র্যান্ড/হাব পেজ র‍্যাংক করতে পারে না, আর দীর্ঘদিন `noindex` থাকলে Google লিংকও ফলো করা বন্ধ করে | এগুলো `index, follow` + sitemap-এ। শুধু privacy/terms/affiliate/404/খালি ক্যাটেগরি noindex |
| S2 | `others` ক্যাটেগরি **সম্পূর্ণ খালি** কিন্তু `index` ও sitemap-এ (thin/soft-404 ঝুঁকি); আরও ৪টা ক্যাটেগরিতে কোনো আর্টিকেল নেই | ক্যাটেগরি তখনই index হবে যখন ≥১টি আর্টিকেল আছে |
| S3 | ক্যাটেগরি টাইটেল বাগ: "AI Writing **AI** Tools & …", "Others AI Tools" | `categoryTitle()` → "AI Writing Tools & Practical Guides 2026 \| AINOVEX" |
| S4 | ডিফল্ট OG ইমেজ Unsplash-এর হটলিংক (বাইরের সার্ভার, বদলে যেতে পারে) | নিজস্ব `/images/og-default.png` (1200×630) |
| S5 | ৩টি আর্টিকেলে `og:image` = ফিচার্ড ছবি (1200×855…) কিন্তু মেটায় ঘোষণা 1200×630 | প্রতিটির জন্য আসল 1200×630 `-og.webp` তৈরি; width/height এখন আসল মান থেকে |
| S6 | Organization `logo` ছিল SVG — Google সাপোর্ট করে না | `logo-512.png` + ImageObject |
| S7 | Home-এ JSON-LD থেকে Organization হারিয়ে যেত; author পেজ `#organization` রেফার করত কিন্তু নোড ছিল না | সব পেজে সংগতিপূর্ণ `@graph` (Organization + WebSite) |
| S8 | BreadcrumbList **ডুপ্লিকেট** (microdata + JSON-LD); ক্যাটেগরি/অন্য পেজে নেই | microdata সরানো; প্রতিটি পেজে একটাই JSON-LD BreadcrumbList |
| S9 | BlogPosting `headline` = metaTitle (ব্র্যান্ডসহ লম্বা) | `headline` = আর্টিকেল শিরোনাম; `wordCount` যোগ |
| S10 | `article:published_time/modified_time/author/section/tag` OG ট্যাগ নেই | যোগ করা হয়েছে; `<time datetime>` ট্যাগও |
| S11 | RSS autodiscovery `<link rel="alternate">`, apple-touch-icon নেই | `index.html` এ যোগ |
| S12 | Sitemap: স্ট্যাটিক পেজ নেই; লিস্টেড URL-এ নকল `lastmod` ঝুঁকি | সব indexable URL; lastmod শুধু আসল কনটেন্ট-তারিখ থাকলে |
| S13 | `top-ai-video-generators-guide` এর excerpt-এ **Sora** আছে, আর্টিকেলে নেই (শিরোনাম/কনটেন্ট মিসম্যাচ) | excerpt ঠিক করা |
| S14 | বড় আর্টিকেলে হেডিং লেভেল এলোমেলো (`###` পরে `##`, `##`, `##`) | সব টুল `###`, একই স্তরে |
| S15 | আর্টিকেল বডির প্রথমে "Published/Updated/Author/Reading time" লাইন — হেডারের সাথে ডুপ্লিকেট | সরানো |
| S16 | আর্টিকেলের বাইরের লিংকে `rel="noopener"`/`target` নেই | markdown renderer এ যোগ (follow রাখা হয়েছে — অফিসিয়াল ডক সাইটেশন) |
| S17 | ক্যাটেগরি/Featured Tools সেকশনের শিরোনাম ক্লায়েন্টে `div`, prerender-এ `h2` — রেন্ডার-করা DOM-এ হেডিং হারায় | `h2` |

## ৪. যা আমি ঠিক করিনি (আপনার সিদ্ধান্ত/যাচাই দরকার)
1. **বিল্ড চালাতে পারিনি।** এই পরিবেশে নেটওয়ার্ক বন্ধ, তাই `npm install`/`vite build` হয়নি। যা করেছি: সব `src` ফাইলের সিনট্যাক্স পার্স, `postbuild.mjs` স্টাব `dist` এ চালিয়ে ২৫টি HTML-এর JSON-LD ও মেটা যাচাই। **Netlify-তে ডিপ্লয় করে একবার দেখে নিন।**
2. **`package-lock.json` নেই** — প্রতি ডিপ্লয়ে ভার্সন বদলে যেতে পারে। লোকালে `npm install` চালিয়ে লকফাইল কমিট করুন। `typescript ^7.0.2`, `vite ^8.3.0` ইত্যাদি ভার্সন আমি যাচাই করতে পারিনি।
3. **কনটেন্ট সংগতি (E-E-A-T):** About/Editorial পেজে লেখা "Every tool … real testing", `best-free-ai-tools-2026` এ "we test and rank" — অথচ বড় আর্টিকেলে স্পষ্ট লেখা "hands-on test করা হয়নি"। দাবি ও বাস্তবতা এক করুন। এছাড়া "Claude 3.5 Sonnet" ২০২৬ অক্টোবরের আর্টিকেলে পুরনো — আপডেট করুন।
4. **Privacy Policy** বলছে "third-party tracker নেই", কিন্তু CSP/কোডে GA, Clarity, AdSense প্রস্তুত। চালু করার আগে পলিসি আপডেট করুন (EU ভিজিটর হলে কনসেন্ট ব্যানার)।
5. **ইমেইল প্রকাশ্য:** `contactEmail` এখন পেজে দৃশ্যমান (স্প্যাম স্ক্র্যাপারের ঝুঁকি)। চাইলে আলাদা ব্র্যান্ড ইমেইল ব্যবহার করুন — শুধু `content/settings.json` বদলাতে হবে।
6. **Netlify ট্রেইলিং-স্ল্যাশ redirect:** `/tools → /tools/` নিয়ম আসলে লুপ করে না কি না — ডিপ্লয়ের পর `curl -I https://ai-novex.netlify.app/tools` দিয়ে যাচাই করুন (প্রত্যাশিত: ১টি 301)।
7. **netlify.app সাবডোমেইন** দীর্ঘমেয়াদে ব্র্যান্ড/অথরিটির জন্য দুর্বল। কাস্টম ডোমেইন নিলে শুধু `content/settings.json` → `productionUrl` ও `scripts/indexnow.mjs`/`index.html` এর ডোমেইন বদলাবে।
8. কনটেন্ট কম (৪টি আর্টিকেল, ৯টি ক্যাটেগরি)। র‍্যাংকিংয়ের জন্য সবচেয়ে বড় লিভার: প্রতি ক্যাটেগরিতে ≥২টি গভীর আর্টিকেল।

## ৫. ডিপ্লয়ের পরে করণীয় (Search Console / Bing)
1. GitHub-এ পুশ → Netlify ডিপ্লয় শেষ হলে `npm run indexnow`।
2. Search Console → Sitemaps → `sitemap.xml` রিসাবমিট (এখন ১৬টি URL)।
3. URL Inspection → হোমপেজ, `/blog/`, `/tools/`, `/about/` এ "Request indexing"।
4. Rich Results Test দিয়ে একটি আর্টিকেল URL চেক (BlogPosting + Breadcrumb)।
5. সোশ্যাল ডিবাগার (Facebook Sharing Debugger / LinkedIn Post Inspector) দিয়ে নতুন OG ইমেজ রিফ্রেশ করুন।
