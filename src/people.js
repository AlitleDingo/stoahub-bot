// Pure text helpers for turning a round page into lists of people (no dependencies).

export const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

const CLUB = /^[A-Z][A-Z0-9]{1,9}$/;
const SUFFIX = /^(I{1,3}|IV|V|VI{0,3}|JR|SR)$/; // "John Smith III" is not a club
const NAME_CLUB = /^(.*?[a-z.'’)])[\s:·|–-]*([A-Z][A-Z0-9]{1,9})$/;

export const isClub = (s) => CLUB.test(s) && !SUFFIX.test(s);

/** "Jane Doe WD40" / "Jane DoeWD40" / "Jane Doe: WD40" -> { name, club } */
export function splitClub(s) {
  s = clean(s).replace(/^\d+[.)]\s+/, '');
  const m = s.match(NAME_CLUB);
  if (m && isClub(m[2])) return { name: clean(m[1]), club: m[2] };
  return { name: s, club: '' };
}

export const fmt = ({ name, club }) => (club ? `${name} (${club})` : name);

/** Speech-style page: rooms of single competitors. Returns an array of rooms, each an array of people. */
export function parseRooms(lines) {
  const rooms = [];
  let cur = null;
  let last = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const m = l.match(/^room\b\s*[:#]?\s*(\S*)$/i);
    if (m) {
      cur = [];
      rooms.push(cur);
      last = null;
      if (!m[1] && i + 1 < lines.length && /^[A-Za-z]?\d{1,3}[A-Za-z]?$/.test(lines[i + 1])) i++; // number on its own line
      continue;
    }
    if (!cur) continue;
    if (last && !last.club && isClub(l)) {
      last.club = l;
      continue;
    }
    const p = splitClub(l);
    if (p.name) {
      last = p;
      cur.push(p);
    }
  }
  return rooms.filter((r) => r.length);
}

const SIDE_A = /^(aff(irmative)?|gov(ernment)?|prop(osition)?)$/i;
const SIDE_B = /^(neg(ative)?|opp(osition)?)$/i;

/** Debate page in list form: "AFF" / names / club / "NEG" / names / club. Returns matchup strings. */
export function parseSides(lines) {
  const out = [];
  let a = null;
  let b = null;
  let want = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (SIDE_A.test(l)) { want = 'a'; continue; }
    if (SIDE_B.test(l)) { want = 'b'; continue; }
    if (!want) continue;
    const p = splitClub(l);
    if (!p.club && i + 1 < lines.length && isClub(lines[i + 1])) {
      p.club = lines[i + 1];
      i++;
    }
    if (want === 'a') a = fmt(p);
    else b = fmt(p);
    want = null;
    if (a && b) {
      out.push(`${a} vs ${b}`);
      a = b = null;
    }
  }
  return out;
}

/** Group rooms into display text: one person per line, blank line between rooms (no room names). */
export function roomsToLines(rooms) {
  const seen = new Set();
  const blocks = [];
  for (const r of rooms) {
    const block = r.map(fmt).join('\n');
    if (seen.has(block)) continue; // mobile + desktop copies of the same page
    seen.add(block);
    blocks.push(block);
  }
  return blocks.join('\n\n');
}
