// Debug helper: node src/inspect.js <stoahub tournament URL or slug>
// Prints exactly what the bot parses from a postings page.
import { fetchPostings, slugFromInput } from './scraper.js';

const slug = slugFromInput(process.argv[2]);
if (!slug) {
  console.error('Usage: node src/inspect.js <tournament URL or slug>');
  process.exit(1);
}
const data = await fetchPostings(slug);
console.log(`Tournament: ${data.name}`);
for (const ev of data.events) {
  console.log(`\n[${ev.group}] ${ev.name} — ${ev.rows.length} row(s)${ev.links.length ? `, ${ev.links.length} link(s)` : ''}`);
  for (const r of ev.rows.slice(0, 8)) console.log(`   ${r}`);
}
