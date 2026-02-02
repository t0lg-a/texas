#!/usr/bin/env node
/**
 * RaceToTheWH daily scraper (GitHub Actions friendly)
 *
 * Why Playwright:
 * - RaceToTheWH poll pages are client-rendered; plain fetch() doesn't reliably contain the poll list.
 *
 * Output: polls.json
 * {
 *   updatedAt, source, sourcePages, polls: [ { category, race, pollster, date_text, start_date, end_date,
 *                                            sample, population, results_text, results:[{choice,pct}], url } ]
 * }
 *
 * Env:
 *   MAX_POLLS (default 600)
 *   DEBUG_SNAPSHOT=1   (writes rtw_snapshot.html)
 */

const fs = require('fs');
const path = require('path');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  console.error('Missing dependency: playwright. In GitHub Actions, install it before running.');
  console.error(e?.message || e);
  process.exit(1);
}

const SOURCE_PAGE = 'https://www.racetothewh.com/allpolls';
const MAX_POLLS = Number(process.env.MAX_POLLS || 600);
const DEBUG_SNAPSHOT = String(process.env.DEBUG_SNAPSHOT || '') === '1';

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function dedupe(polls) {
  const seen = new Set();
  const out = [];
  for (const p of polls) {
    const key = `${p.url || ''}|${(p.results_text || '').slice(0, 160)}|${p.date_text || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

async function run() {
  const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  const context = await browser.newContext({
    userAgent: 'Theo-PollsBot/1.0 (+github actions; racetothewh scrape)',
    viewport: { width: 1280, height: 720 },
  });

  const page = await context.newPage();
  page.setDefaultNavigationTimeout(120000);

  // Speed: block heavy resources (keeps JS/XHR).
  await page.route('**/*', (route) => {
    const t = route.request().resourceType();
    if (t === 'image' || t === 'media' || t === 'font') return route.abort();
    return route.continue();
  });

  console.log(`Opening ${SOURCE_PAGE} ...`);

  // IMPORTANT: 'networkidle' frequently never happens on modern sites (analytics / long-polling).
  // Use DOMContentLoaded + explicit selector wait instead.
  try {
    await page.goto(SOURCE_PAGE, { waitUntil: 'domcontentloaded', timeout: 120000 });
  } catch (e) {
    console.warn('WARN: goto(domcontentloaded) failed:', e?.message || e);
    // Fallback: load as far as possible, then proceed.
    await page.goto(SOURCE_PAGE, { waitUntil: 'commit', timeout: 120000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
  }

  // Wait for poll links to exist (client-rendered).
  await page.waitForSelector('a[href^="http"]:not([href*="racetothewh.com"])', { timeout: 90000 }).catch(() => {});

  // Give client JS a moment to paint.
  await page.waitForTimeout(1500);

  // Attempt to close common cookie banners if present (best-effort)
  try {
    const candidates = [
      'button:has-text("Accept")',
      'button:has-text("I Accept")',
      'button:has-text("Agree")',
      'button:has-text("OK")',
      'text=Accept Cookies',
    ];
    for (const sel of candidates) {
      const btn = page.locator(sel).first();
      if (await btn.count()) {
        await btn.click({ timeout: 1500 }).catch(() => {});
        break;
      }
    }
  } catch {}

  // Best-effort block detection (Cloudflare / bot wall). If this triggers, you need a different source.
  const bodyText = await page.textContent('body').catch(() => '') || '';
  const title = await page.title().catch(() => '') || '';
  const maybeBlocked = /just a moment|checking your browser|cf-chl|cloudflare|access denied|attention required/i.test(title + ' ' + bodyText);
  if (maybeBlocked) {
    if (DEBUG_SNAPSHOT) {
      const html = await page.content();
      fs.writeFileSync('rtw_blocked.html', html);
      console.log('Wrote rtw_blocked.html (detected block page)');
    }
    throw new Error('RaceToTheWH appears to be blocking headless traffic (Cloudflare/bot wall). Enable DEBUG_SNAPSHOT=1 to inspect HTML, or switch data source.');
  }

  if (DEBUG_SNAPSHOT) {
    const html = await page.content();
    fs.writeFileSync('rtw_snapshot.html', html);
    console.log('Wrote rtw_snapshot.html (DEBUG_SNAPSHOT=1)');
  }

  const polls = await page.evaluate((MAX_POLLS) => {
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

    const isExternalPollUrl = (href) => {
      if (!href) return false;
      const h = href.toLowerCase();
      if (!h.startsWith('http')) return false;
      // Ignore internal + social links
      if (h.includes('racetothewh.com')) return false;
      if (h.includes('twitter.com') || h.includes('x.com')) return false;
      if (h.includes('facebook.com')) return false;
      if (h.includes('instagram.com')) return false;
      if (h.includes('youtube.com')) return false;
      if (h.includes('tiktok.com')) return false;
      return true;
    };

    const inferCategory = (txt) => {
      const t = txt.toLowerCase();
      if (t.includes('generic ballot')) return 'generic_ballot';
      if (t.includes('approval')) return 'approval';
      if (t.includes('senate')) return 'senate';
      if (t.includes('governor')) return 'governor';
      if (t.includes('house')) return 'house';
      if (t.includes('democratic') && t.includes('primary')) return 'dem_primary';
      if (t.includes('republican') && t.includes('primary')) return 'gop_primary';
      if (t.includes('general election')) return 'pres_general';
      if (t.includes('president') || t.includes('presidential')) return 'president';
      return 'other';
    };

    const extractResults = (txt) => {
      const out = [];
      // captures: "Name 47%" (names may include punctuation)
      const re = /([A-Za-z][A-Za-z\.'’\-]+(?:\s+[A-Za-z][A-Za-z\.'’\-]+){0,4})\s+(\d{1,2}(?:\.\d+)?)\s*%/g;
      let m;
      while ((m = re.exec(txt)) !== null) {
        const choice = clean(m[1]);
        const pct = Number(m[2]);
        if (Number.isFinite(pct)) out.push({ choice, pct });
        if (out.length >= 10) break;
      }

      // captures: "47-43" (common shorthand); we label as A/B
      if (out.length === 0) {
        const re2 = /\b(\d{1,2}(?:\.\d+)?)\s*[-–]\s*(\d{1,2}(?:\.\d+)?)\b/;
        const m2 = txt.match(re2);
        if (m2) {
          const a = Number(m2[1]);
          const b = Number(m2[2]);
          if (Number.isFinite(a) && Number.isFinite(b)) {
            out.push({ choice: 'A', pct: a }, { choice: 'B', pct: b });
          }
        }
      }

      return out;
    };

    const extractDateText = (txt) => {
      // Try to find something that looks like a date span.
      // Examples: "Jan 12-15", "Jan 12-15, 2026", "01/12 - 01/15"
      const lines = txt.split(/\n+/).map(clean).filter(Boolean);
      const dateRe = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:\s*[-–]\s*\d{1,2})?(?:,?\s*\d{4})?/i;
      for (const line of lines.slice(0, 8)) {
        if (dateRe.test(line)) return line.match(dateRe)[0];
      }
      const numRe = /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?:\s*[-–]\s*\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)?/;
      for (const line of lines.slice(0, 8)) {
        const m = line.match(numRe);
        if (m) return m[0];
      }
      return '';
    };

    const extractSample = (txt) => {
      const m = txt.match(/\b(?:n|N)\s*=\s*(\d{2,6})\b/);
      if (m) return `n=${m[1]}`;
      const m2 = txt.match(/\b(\d{2,6})\s*(LV|RV|A|Adults|Voters)\b/i);
      if (m2) return `${m2[1]} ${m2[2].toUpperCase()}`;
      return '';
    };

    const pickPollster = (txt) => {
      // Best-effort: if a line starts with a known pattern like "Pollster:".
      const m = txt.match(/\bPollster\s*:\s*([^\n\r]+)\b/i);
      if (m) return clean(m[1]);
      // Otherwise, use first line if it's short and doesn't look like results.
      const lines = txt.split(/\n+/).map(clean).filter(Boolean);
      if (!lines.length) return '';
      const first = lines[0];
      if (first.length <= 48 && !/%/.test(first)) return first;
      return '';
    };

    const pickRace = (txt) => {
      // Try to find explicit "STATE Senate" / "STATE Governor" / "District" patterns.
      const m1 = txt.match(/\b([A-Z][a-z]+)\s+(Senate|Governor)\b/);
      if (m1) return `${m1[1]} ${m1[2]}`;
      const m2 = txt.match(/\b(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\s+(Senate|Governor)\b/);
      if (m2) return `${m2[0]}`;
      if (txt.toLowerCase().includes('generic ballot')) return 'Generic Ballot';
      if (txt.toLowerCase().includes('approval')) return 'Trump Approval';
      return '';
    };

    // Collect external links, then pull a "poll block" around each one.
    const anchors = Array.from(document.querySelectorAll('a[href]'))
      .filter(a => isExternalPollUrl(a.getAttribute('href')));

    const blocks = [];
    for (const a of anchors) {
      let el = a;
      let chosen = null;
      for (let i = 0; i < 8 && el; i++) {
        const txt = (el.innerText || '').trim();
        // A poll block usually contains percentages and is not huge.
        if (txt.includes('%') && txt.length >= 20 && txt.length <= 1200) {
          chosen = el;
          break;
        }
        el = el.parentElement;
      }
      if (!chosen) continue;

      const txt = chosen.innerText || '';
      const results = extractResults(txt);
      const results_text = clean(txt);

      // If we can't extract any structured result, skip unless it's clearly a poll block.
      if (results.length === 0 && !/%/.test(txt)) continue;

      blocks.push({
        url: a.href,
        category: inferCategory(txt),
        race: pickRace(txt),
        pollster: pickPollster(txt),
        date_text: extractDateText(txt),
        sample: extractSample(txt),
        population: '',
        results_text,
        results,
      });

      if (blocks.length >= MAX_POLLS) break;
    }

    return blocks;
  }, MAX_POLLS);

  await browser.close();

  const out = {
    updatedAt: new Date().toISOString(),
    source: 'racetothewh',
    sourcePages: [SOURCE_PAGE],
    polls: dedupe(polls).slice(0, MAX_POLLS),
  };

  if (!Array.isArray(out.polls) || out.polls.length < 10) {
    throw new Error(
      `Scrape produced too few poll rows (${out.polls?.length || 0}).\n` +
      `This usually means the site DOM changed or the poll list did not render in headless mode.\n` +
      `Try setting DEBUG_SNAPSHOT=1 to inspect rtw_snapshot.html and adjust extraction heuristics.`
    );
  }

  fs.writeFileSync('polls.json', JSON.stringify(out, null, 2));
  console.log(`Done. Wrote polls.json with ${out.polls.length} rows.`);
}

run().catch((err) => {
  console.error('Critical Error:', err?.stack || err);
  process.exit(1);
});
