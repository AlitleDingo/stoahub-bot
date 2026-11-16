import * as cheerio from 'cheerio';
import { clean, fmt, isClub, parseRooms, parseSides, roomsToLines, splitClub } from './people.js';

export const BASE = 'https://stoahub.org';
const UA = 'StoaHubPostingsBot/1.0 (personal Discord notifier; low-frequency polling)';

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
  const links = new Map();
  $scope.add($scope.find('a')).filter('a[href]').each((_, a) => {
    try {
      const u = new URL($(a).attr('href'), BASE);
      if (u.origin !== BASE || !u.pathname.startsWith(prefix)) return;
      const href = u.origin + u.pathname + u.search;
      if (links.has(href)) return;
      // "1 Mon 11/16 10:00 am - Speech A Round 1 -- Pattern A" -> drop the leading row number
      const label = clean($(a).text()).replace(/^\d+\s+/, '');
      links.set(href, { href, label });
    } catch { /* ignore bad hrefs */ }
  });
  return [...links.values()];
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

const BLOCKS = 'div,p,li,tr,td,th,h1,h2,h3,h4,h5,h6,section,article,ul,ol,table,dt,dd,label,summary,details';

/** Visible text of a node as trimmed lines, breaking at block elements and <br>. */
function blockLines($, $root) {
  const $c = $root.clone();
  $c.find('script,style,noscript,svg,button,input,select,textarea').remove();
  $c.find('br').replaceWith('\n');
  $c.find(BLOCKS).each((_, el) => {
    $(el).prepend('\n').append('\n');
  });
  return $c.text().split('\n').map(clean).filter(Boolean);
}

function teamText($, $cell) {
  const lines = blockLines($, $cell);
  if (!lines.length) return '';
  const last = lines[lines.length - 1];
  if (lines.length >= 2 && isClub(last)) return fmt({ name: lines.slice(0, -1).join(' '), club: last });
  return fmt(splitClub(lines.join(' ')));
}

/** Debate tables: Room | Affirmative | Negative -> "A vs B" (room dropped). */
function parseTables($, $root) {
  const out = [];
  $root.find('table').each((_, t) => {
    const heads = $(t).find('th').map((__, h) => clean($(h).text()).toLowerCase()).get();
    if (!heads.some((h) => /^(aff|neg|gov|opp|prop)/.test(h))) return;
    $(t).find('tr').each((__, tr) => {
      const cells = $(tr).children('th,td').toArray();
      if (cells.length < 3 || !$(tr).find('td').length) return;
      const sides = cells.slice(1).map((c) => teamText($, $(c))).filter(Boolean);
      if (sides.length >= 2) out.push(sides.join(' vs '));
    });
  });
  return [...new Set(out)];
}

/** Names on one round page, as display text. Empty string if the layout wasn't recognised. */
export function parseSubPage(html) {
  const $ = cheerio.load(html);
  const $root = $('main').length ? $('main').first() : $('body');

  const matchups = parseTables($, $root);
  if (matchups.length) return matchups.join('\n');

  let lines = blockLines($, $root);
  const cut = lines.findIndex((l) => /^postings by name/i.test(l)); // the by-name index repeats everything
  if (cut >= 0) lines = lines.slice(0, cut);

  const sides = [...new Set(parseSides(lines))];
  if (sides.length) return sides.join('\n');

  return roomsToLines(parseRooms(lines));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Each event's row list becomes one entry per round: a bold label plus the people in it.
 * ev.incomplete = true when a round page failed to load, so the poller keeps the old rows
 * instead of announcing a half-empty update.
 */
export async function fetchPostings(slug) {
  const data = parsePostings(await fetchHtml(postingsUrl(slug)), slug);
  for (const ev of data.events) {
    if (!ev.links.length) continue;
    const rounds = [];
    for (const link of ev.links.slice(0, 8)) {
      await sleep(400);
      const label = link.label || 'Round';
      try {
        const people = parseSubPage(await fetchHtml(link.href));
        rounds.push(people ? `**${label}**\n${people}` : `**${label}**`);
      } catch (e) {
        console.warn(`round page failed ${link.href}: ${e.message}`);
        ev.incomplete = true;
      }
    }
    if (rounds.length) ev.rows = rounds;
  }
  return data;
}
