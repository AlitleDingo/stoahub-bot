import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const FILE = path.join(DIR, 'state.json');

let state = { subs: [], tournaments: {} };

export function load() {
  fs.mkdirSync(DIR, { recursive: true });
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    state = { subs: parsed.subs ?? [], tournaments: parsed.tournaments ?? {} };
  } catch (e) {
    if (e.code !== 'ENOENT') {
      // Never start with an empty state over a file we couldn't read: the next save would wipe it.
      console.error(`Could not read ${FILE}: ${e.message}. Refusing to start so nothing gets overwritten.`);
      process.exit(1);
    }
  }
  console.log(`State: ${state.subs.length} subscription(s) in ${FILE}`);
}

function save() {
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, FILE);
}

export const MAX_SUBS_PER_USER = 10;

export const subsFor = (userId) => state.subs.filter((s) => s.userId === userId);
export const allSubs = () => state.subs;
export const trackedSlugs = () => [...new Set(state.subs.map((s) => s.slug))];

export function addSub({ userId, guildId, channelId, slug, tournamentName, events }) {
  // Same user + tournament + destination = replace (re-running /config edits it).
  state.subs = state.subs.filter(
    (s) => !(s.userId === userId && s.slug === slug && (s.channelId ?? null) === (channelId ?? null)),
  );
  if (subsFor(userId).length >= MAX_SUBS_PER_USER) return null;
  const sub = {
    id: crypto.randomUUID().slice(0, 8),
    userId,
    guildId: guildId ?? null,
    channelId: channelId ?? null,
    slug,
    tournamentName,
    events,
    createdAt: Date.now(),
  };
  state.subs.push(sub);
  save();
  return sub;
}

export function removeSub(id, userId) {
  const before = state.subs.length;
  state.subs = state.subs.filter((s) => !(s.id === id && s.userId === userId));
  if (state.subs.length !== before) save();
  return state.subs.length !== before;
}

export function removeSubsByChannel(channelId) {
  const before = state.subs.length;
  state.subs = state.subs.filter((s) => s.channelId !== channelId);
  if (state.subs.length !== before) save();
}

export const getSub = (id) => state.subs.find((s) => s.id === id);

export const getTournament = (slug) => state.tournaments[slug] ?? null;

export function setTournament(slug, parsed) {
  const events = {};
  for (const ev of parsed.events) events[ev.name] = ev.rows;
  state.tournaments[slug] = { name: parsed.name, events, updatedAt: Date.now() };
  save();
}

/** Drop stored snapshots nobody is subscribed to anymore. */
export function prune() {
  const keep = new Set(trackedSlugs());
  for (const slug of Object.keys(state.tournaments)) if (!keep.has(slug)) delete state.tournaments[slug];
  save();
}
