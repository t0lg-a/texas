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
  const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage','--no-sandbox','--disable-setuid-sandbox','--disable-blink-features=AutomationControlled'] });
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

  // Give the client app time to render (and any iframes to load).
  await page.waitForTimeout(8000);

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

    // Try to trigger any lazy-rendering by scrolling.
    for (let i = 0; i < 6; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(900);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(600);

    // Optional: screenshot + HTML snapshot for debugging
    if (DEBUG_SNAPSHOT) {
      await page.screenshot({ path: 'rtw.png', fullPage: true }).catch(() => {});
      console.log('Wrote rtw.png (DEBUG_SNAPSHOT=1)');
    }

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

  async function extractPollsInFrame(frame) {
    try {
      return await frame.evaluate((MAX_POLLS) => {
        const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

        const isNoiseHref = (href) => {
          if (!href) return true;
          const h = href.toLowerCase();
          if (h.startsWith('#')) return true;
          if (h.startsWith('mailto:') || h.startsWith('tel:')) return true;
          if (h.includes('twitter.com') || h.includes('x.com')) return true;
          if (h.includes('facebook.com')) return true;
          if (h.includes('instagram.com')) return true;
          if (h.includes('youtube.com')) return true;
          if (h.includes('tiktok.com')) return true;
          return false;
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
          const re = /([A-Za-z][A-Za-z\.'’\-]+(?:\s+[A-Za-z][A-Za-z\.'’\-]+){0,4})\s+(\d{1,2}(?:\.\d+)?)\s*%/g;
          let m;
          while ((m = re.exec(txt)) !== null) {
            const choice = clean(m[1]);
            const pct = Number(m[2]);
            if (Number.isFinite(pct)) out.push({ choice, pct });
            if (out.length >= 12) break;
          }
          if (out.length === 0) {
            const re2 = /\b(\d{1,2}(?:\.\d+)?)\s*[-–]\s*(\d{1,2}(?:\.\d+)?)\b/;
            const m2 = txt.match(re2);
            if (m2) {
              const a = Number(m2[1]);
              const b = Number(m2[2]);
              if (Number.isFinite(a) && Number.isFinite(b)) out.push({ choice: 'A', pct: a }, { choice: 'B', pct: b });
            }
          }
          return out;
        };

        const extractDateText = (txt) => {
          const lines = txt.split(/\n+/).map(clean).filter(Boolean);
          const dateRe = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:\s*[-–]\s*\d{1,2})?(?:,?\s*\d{4})?/i;
          for (const line of lines.slice(0, 12)) {
            const m = line.match(dateRe);
            if (m) return m[0];
          }
          const numRe = /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?:\s*[-–]\s*\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)?/;
          for (const line of lines.slice(0, 12)) {
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
          const lines = txt.split(/\n+/).map(clean).filter(Boolean);
          for (const line of lines.slice(0, 10)) {
            const m = line.match(/^(?:Pollster|Poll|Firm)\s*:?\s*(.+)$/i);
            if (m) return m[1].slice(0, 100);
          }
          if (lines.length) return lines[0].slice(0, 100);
          return '';
        };

        const pickRace = (txt) => {
          const lines = txt.split(/\n+/).map(clean).filter(Boolean);
          for (const line of lines.slice(0, 12)) {
            if (/(senate|governor|house|president|primary|generic ballot|approval)/i.test(line)) return line.slice(0, 120);
            if (/\b[A-Z]{2}\b.*\b(Senate|Governor)\b/.test(line)) return line.slice(0, 120);
            if (/\b[A-Z]{2}\-\d{2}\b/.test(line)) return line.slice(0, 120);
          }
          return '';
        };

        const isLikelyPollBlock = (txt) => {
          if (!txt) return false;
          if (!txt.includes('%')) return false;
          if (txt.length < 25 || txt.length > 2200) return false;
          const t = txt.toLowerCase();
          return /(lv|rv|likely voters|registered voters|n=|poll|survey|approve|disapprove|ballot|senate|governor|house|primary|republican|democrat|gop|dem)/.test(t);
        };

        const anchors = Array.from(document.querySelectorAll('a[href]'))
          .filter(a => !a.closest('header, nav, footer'))
          .filter(a => !isNoiseHref(a.getAttribute('href')));

        const blocks = [];
        const seenEl = new Set();

        for (const a of anchors) {
          let el = a;
          let chosen = null;
          for (let i = 0; i < 10 && el; i++) {
            const txt = (el.innerText || '').trim();
            if (isLikelyPollBlock(txt)) { chosen = el; break; }
            el = el.parentElement;
          }
          if (!chosen) continue;
          if (seenEl.has(chosen)) continue;
          seenEl.add(chosen);

          const txt = chosen.innerText || '';
          const results = extractResults(txt);
          if (results.length === 0) continue;

          const links = Array.from(chosen.querySelectorAll('a[href]'))
            .filter(x => !isNoiseHref(x.getAttribute('href')))
            .map(x => x.href);

          let bestUrl = a.href || '';
          for (const h of links) {
            const hl = String(h).toLowerCase();
            if (hl.startsWith('http') && !hl.includes('racetothewh.com')) { bestUrl = h; break; }
          }
          if (!bestUrl && links.length) bestUrl = links[0] || '';

          blocks.push({
            url: bestUrl,
            category: inferCategory(txt),
            race: pickRace(txt),
            pollster: pickPollster(txt),
            date_text: extractDateText(txt),
            sample: extractSample(txt),
            population: '',
            results_text: clean(txt),
            results,
          });

          if (blocks.length >= MAX_POLLS) break;
        }

        // Fallback: scan generic containers for poll-like blocks
        if (blocks.length < 5) {
          const elems = Array.from(document.querySelectorAll('div, li, p, article, section'))
            .filter(el => !el.closest('header, nav, footer'))
            .slice(0, 2500);

          for (const el of elems) {
            const txt = (el.innerText || '').trim();
            if (!isLikelyPollBlock(txt)) continue;
            const results = extractResults(txt);
            if (results.length === 0) continue;

            const links = Array.from(el.querySelectorAll('a[href]'))
              .filter(x => !isNoiseHref(x.getAttribute('href')))
              .map(x => x.href);

            const bestUrl = links.find(h => h && h.startsWith('http') && !h.toLowerCase().includes('racetothewh.com')) || links[0] || '';

            blocks.push({
              url: bestUrl,
              category: inferCategory(txt),
              race: pickRace(txt),
              pollster: pickPollster(txt),
              date_text: extractDateText(txt),
              sample: extractSample(txt),
              population: '',
              results_text: clean(txt),
              results,
            });

            if (blocks.length >= MAX_POLLS) break;
          }
        }

        return blocks;
      }, MAX_POLLS);
    } catch (_) {
      return [];
    }
  }

  const frames = page.frames();
  console.log(`Frames detected: ${frames.length}`);

  let polls = [];
  for (const f of frames) {
    const part = await extractPollsInFrame(f);
    if (Array.isArray(part) && part.length) polls = polls.concat(part);
  }



  const out = {
    updatedAt: new Date().toISOString(),
    source: 'racetothewh',
    sourcePages: [SOURCE_PAGE],
    polls: dedupe(polls).slice(0, MAX_POLLS),
  };

  if (!Array.isArray(out.polls) || out.polls.length < 10) {
    // Always dump HTML + screenshot on failure (so you can inspect what GH Actions actually received).
    try {
      const html = await page.content();
      fs.writeFileSync('rtw_snapshot.html', html);
      console.log('Wrote rtw_snapshot.html (auto on failure)');
    } catch (_) {}
    try {
      await page.screenshot({ path: 'rtw.png', fullPage: true });
      console.log('Wrote rtw.png (auto on failure)');
    } catch (_) {}

    try {
      const title = await page.title();
      const text = (await page.textContent('body')) || '';
      console.log('Page title:', title);
      console.log('Body snippet:', String(text).slice(0, 800));
    } catch (_) {}

    await browser.close();

    throw new Error(
      `Scrape produced too few poll rows (${out.polls?.length || 0}).\n` +
      `Either the page didn’t render poll blocks in headless mode, or the markup differs from what we expect.\n` +
      `Inspect rtw_snapshot.html / rtw.png from the workflow artifacts to see whether you got a bot wall, a blank shell, or a new DOM.`
    );
  }

  fs.writeFileSync('polls.json', JSON.stringify(out, null, 2));
  await browser.close();
  console.log(`Done. Wrote polls.json with ${out.polls.length} rows.`);
}

run().catch((err) => {
  console.error('Critical Error:', err?.stack || err);
  process.exit(1);
});
