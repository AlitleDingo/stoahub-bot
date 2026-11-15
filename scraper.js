import * as cheerio from 'cheerio';

export const BASE = 'https://stoahub.org';
const UA = 'StoaHubPostingsBot/1.0 (personal Discord notifier; low-frequency polling)';

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const NO_POSTINGS = /^no postings( yet)?\.?$/i;

export const postingsUrl = (slug) => `${BASE}/tournament/${slug}/postings`;

export function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Accepts a full StoaHub URL or a bare slug. Returns a slug or null. */
export function slugFromInput(input) {
  const s = String(input ?? '').trim();
  const m = s.match(/\/tournament\/([a-z0-9-]+)/i);
  if (m) return m[1].toLowerCase();
  const bare = s.toLowerCase();
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(bare) ? bare : null;
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} for ${url}`);
    err.status = res.status;
    throw err;
  }
  return res.text();
}

/**
 * Upcoming tournaments from the public calendar.
 * Logged-out visitors get no links, so slugs are derived from name + year
 * ("<name-slug>-<year>") and verified later when the user picks one.
 */
export async function fetchCalendar() {
  const $ = cheerio.load(await fetchHtml(`${BASE}/calendar`));
  const out = [];
  $('table tr').each((_, tr) => {
    const td = $(tr).find('td');
    if (td.length < 3) return;
    const date = clean($(td[0]).text());
    const name = clean($(td[1]).text());
    const city = clean($(td[2]).text());
    if (!name) return;
    const href = $(td[1]).find('a').attr('href');
    const year = (date.match(/\d{4}/) || [])[0];
    let slug = href ? slugFromInput(href) : null;
    if (!slug && year) slug = `${slugify(name)}-${year}`;
    if (slug) out.push({ name, date, city, slug });
  });
  return out;
}

function extractRows($, $nodes) {
  const rows = [];
  const seen = new Set();
  const push = (t) => {
    t = clean(t);
    if (!t || NO_POSTINGS.test(t) || seen.has(t)) return;
    seen.add(t);
    rows.push(t);
  };

  const $all = $nodes.add($nodes.find('*'));

  const trs = $all.filter('tr');
  if (trs.length) {
    trs.each((_, tr) => {
      const cells = $(tr)
        .children('th,td')
        .map((__, c) => clean($(c).text()))
        .get()
        .filter(Boolean);
      push(cells.join(' | '));
    });
    return rows;
  }

  const lis = $all.filter('li');
  if (lis.length) {
    lis.each((_, li) => push($(li).text()));
    return rows;
  }

  $all
    .filter((_, el) => $(el).children().length === 0)
    .each((_, el) => push($(el).text()));
  if (!rows.length) push($nodes.text());
  return rows;
}

function sameTournamentLinks($, $scope, slug) {
  const prefix = `/tournament/${slug}/postings/`;
  const links = new Set();
  $scope.add($scope.find('a')).filter('a[href]').each((_, a) => {
    try {
      const u = new URL($(a).attr('href'), BASE);
      if (u.origin === BASE && u.pathname.startsWith(prefix)) links.add(u.origin + u.pathname + u.search);
    } catch { /* ignore bad hrefs */ }
  });
  return [...links];
}

export function parsePostings(html, slug) {
  const $ = cheerio.load(html);
  $('script, style, noscript').remove();

  const name = clean($('h1').first().text()) || slug;

  // Walk headings in document order: h2 "Postings" -> h3 groups -> h4 events.
  let inPostings = false;
  let group = '';
  const heads = [];
  $('h2, h3, h4').each((_, el) => {
    const tag = el.tagName.toLowerCase();
    const text = clean($(el).text());
    if (tag === 'h2') {
      inPostings = /^postings$/i.test(text);
      group = '';
    } else if (tag === 'h3') {
      if (inPostings) group = text;
    } else if (inPostings && text) {
      heads.push({ el, group });
    }
  });

  const events = [];
  for (const { el, group: g } of heads) {
    const $h = $(el);
    let $body = $h.nextUntil('h2, h3, h4');

    if (!$body.length) {
      // Heading is wrapped (e.g. <details><summary><h4>): climb to the smallest box that holds only this event.
      let box = $h.parent();
      while (box.length && box.parent().length && box.parent().find('h4').length === 1 && !box.parent().is('body, main')) {
        box = box.parent();
      }
      const copy = box.clone();
      copy.find('h2, h3, h4').remove();
      $body = copy.children().length ? copy.children() : copy;
    }

    const links = sameTournamentLinks($, $body.add($h), slug);
    events.push({ name: clean($h.text()), group: g, rows: extractRows($, $body), links });
  }

  return { name, events };
}

/** Parse a sub-page of an event (only used when the main page links out and has no inline rows). */
function parseSubPage(html) {
  const $ = cheerio.load(html);
  $('script, style, noscript, header, nav, footer, [role="navigation"]').remove();
  const $root = $('main').length ? $('main').first() : $('body');
  $root.find('h1, h2, h3, h4').remove();
  return extractRows($, $root.children().length ? $root.children() : $root);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchPostings(slug) {
  const data = parsePostings(await fetchHtml(postingsUrl(slug)), slug);
  for (const ev of data.events) {
    if (ev.rows.length || !ev.links.length) continue;
    const rows = [];
    for (const link of ev.links.slice(0, 4)) {
      await sleep(500);
      try {
        rows.push(...parseSubPage(await fetchHtml(link)));
      } catch (e) {
        console.warn(`sub-page failed ${link}: ${e.message}`);
      }
    }
    ev.rows = [...new Set(rows)];
  }
  return data;
}
