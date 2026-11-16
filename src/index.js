import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import * as store from './store.js';
import { fetchCalendar, fetchPostings, postingsUrl, slugFromInput } from './scraper.js';

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error('DISCORD_TOKEN is not set.');
  process.exit(1);
}
const POLL_MS = Math.max(1, Number(process.env.POLL_MINUTES) || 3) * 60_000;
const EPHEMERAL = MessageFlags.Ephemeral;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const trunc = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const row = (...c) => new ActionRowBuilder().addComponents(...c);

/** Split text blocks into pages that fit an embed description, breaking on lines rather than mid-name. */
function pages(blocks, max = 3800) {
  const pieces = [];
  for (const b of blocks) {
    if (b.length <= max) {
      pieces.push(b);
      continue;
    }
    let cur = '';
    for (const line of b.split('\n')) {
      if (cur && cur.length + line.length + 1 > max) {
        pieces.push(cur);
        cur = '';
      }
      cur += (cur ? '\n' : '') + trunc(line, max);
    }
    if (cur) pieces.push(cur);
  }
  const out = [];
  let cur = '';
  for (const p of pieces) {
    if (cur && cur.length + p.length + 2 > max) {
      out.push(cur);
      cur = '';
    }
    cur += (cur ? '\n\n' : '') + p;
  }
  if (cur) out.push(cur);
  return out;
}

process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
  new SlashCommandBuilder()
    .setName('config')
    .setDescription('Choose a tournament and events to get postings alerts for'),
  new SlashCommandBuilder()
    .setName('subs')
    .setDescription('View, test, or remove your postings alerts'),
];

/* ───────────── calendar cache + setup sessions ───────────── */

let calCache = { at: 0, data: [] };
async function getCalendar() {
  if (calCache.data.length && Date.now() - calCache.at < 10 * 60_000) return calCache.data;
  const data = await fetchCalendar();
  if (data.length) calCache = { at: Date.now(), data };
  return data;
}

const sessions = new Map(); // userId -> { slug, parsed, events, at }
function getSession(userId) {
  const s = sessions.get(userId);
  if (!s || Date.now() - s.at > 15 * 60_000) {
    sessions.delete(userId);
    return null;
  }
  return s;
}

/* ───────────── /config panels ───────────── */

const urlButton = () =>
  new ButtonBuilder().setCustomId('cfg:url').setLabel('Paste a URL instead').setStyle(ButtonStyle.Secondary);

function tournamentPanel(cal, page) {
  const list = cal.filter((t) => t.slug.length <= 100);
  const pages = Math.max(1, Math.ceil(list.length / 25));
  page = Math.min(Math.max(page, 0), pages - 1);
  const slice = list.slice(page * 25, page * 25 + 25);

  const components = [];
  if (slice.length) {
    components.push(
      row(
        new StringSelectMenuBuilder()
          .setCustomId('cfg:tour')
          .setPlaceholder('Pick a tournament…')
          .addOptions(
            slice.map((t) => ({
              label: trunc(t.name, 100),
              description: trunc(`${t.date} · ${t.city}`, 100),
              value: t.slug,
            })),
          ),
      ),
    );
  }
  components.push(
    row(
      new ButtonBuilder()
        .setCustomId(`cfg:page:${page - 1}`)
        .setLabel('◀ Prev')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId(`cfg:page:${page + 1}`)
        .setLabel('Next ▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= pages - 1),
      urlButton(),
    ),
  );
  return { content: `**Step 1/3 · Which tournament?** (page ${page + 1}/${pages})`, components };
}

function eventsPanel(session) {
  const evs = session.parsed.events.slice(0, 25);
  const components = [];
  if (evs.length) {
    components.push(
      row(
        new StringSelectMenuBuilder()
          .setCustomId('cfg:events')
          .setPlaceholder('Pick specific events…')
          .setMinValues(1)
          .setMaxValues(evs.length)
          .addOptions(
            evs.map((e) => {
              const o = { label: trunc(e.name, 100), value: trunc(e.name, 100) };
              if (e.group) o.description = trunc(e.group, 100);
              return o;
            }),
          ),
      ),
    );
  }
  components.push(
    row(new ButtonBuilder().setCustomId('cfg:evall').setLabel('All events').setStyle(ButtonStyle.Primary)),
  );
  return {
    content: `**Step 2/3 · Which events?**\n${session.parsed.name}${
      evs.length ? '' : '\n_No events listed on the page yet — choose "All events"._'
    }`,
    components,
  };
}

function destPanel(session, inGuild) {
  const events = session.events.length ? session.events.join(', ') : 'all events';
  const components = [];
  if (inGuild) {
    components.push(
      row(
        new ChannelSelectMenuBuilder()
          .setCustomId('cfg:chan')
          .setPlaceholder('Post in a channel…')
          .setChannelTypes([ChannelType.GuildText, ChannelType.GuildAnnouncement]),
      ),
    );
  }
  components.push(
    row(new ButtonBuilder().setCustomId('cfg:dm').setLabel('Send to my DMs').setStyle(ButtonStyle.Primary)),
  );
  return {
    content: trunc(`**Step 3/3 · Where should alerts go?**\n${session.parsed.name} — ${events}`, 1900),
    components,
  };
}

async function chooseTournament(i, slug) {
  let parsed;
  try {
    parsed = await fetchPostings(slug);
  } catch (e) {
    const why =
      e.status === 404
        ? `I couldn't find a postings page for \`${slug}\`.`
        : `StoaHub didn't respond (${e.message}).`;
    return i.editReply({ content: `${why} Paste the tournament URL instead.`, components: [row(urlButton())] });
  }
  const session = { slug, parsed, events: [], at: Date.now() };
  sessions.set(i.user.id, session);
  return i.editReply(eventsPanel(session));
}

async function finalize(i, channelId) {
  const s = getSession(i.user.id);
  if (!s) return i.editReply({ content: 'That setup expired — run /config again.', components: [] });

  const sub = store.addSub({
    userId: i.user.id,
    guildId: i.guildId,
    channelId,
    slug: s.slug,
    tournamentName: s.parsed.name,
    events: s.events,
  });
  if (!sub) {
    return i.editReply({
      content: `You're at the ${store.MAX_SUBS_PER_USER}-subscription limit. Remove one with /subs first.`,
      components: [],
    });
  }
  if (!store.getTournament(s.slug)) store.setTournament(s.slug, s.parsed); // baseline: only alert on changes from now on
  sessions.delete(i.user.id);

  return i.editReply({
    content: trunc(
      `✅ **${s.parsed.name}**\nEvents: ${s.events.length ? s.events.join(', ') : 'all'}\nSending to: ${
        channelId ? `<#${channelId}>` : 'your DMs'
      }\nI check every ${Math.round(POLL_MS / 60_000)} min and alert on new or changed postings. Use /subs to see current postings or remove this.`,
      1900,
    ),
    components: [],
  });
}

/* ───────────── /subs panels ───────────── */

function subsPanel(userId) {
  const subs = store.subsFor(userId);
  if (!subs.length) return { content: 'You have no alerts yet. Run /config to add one.', components: [] };
  const lines = subs.map(
    (s) =>
      `• **${s.tournamentName}** — ${s.events.length ? s.events.join(', ') : 'all events'} → ${
        s.channelId ? `<#${s.channelId}>` : 'DMs'
      }`,
  );
  return {
    content: trunc(`**Your alerts**\n${lines.join('\n')}`, 1900),
    components: [
      row(
        new StringSelectMenuBuilder()
          .setCustomId('subs:pick')
          .setPlaceholder('Manage one…')
          .addOptions(
            subs.map((s) => ({
              label: trunc(s.tournamentName, 100),
              description: trunc(s.events.length ? s.events.join(', ') : 'all events', 100),
              value: s.id,
            })),
          ),
      ),
    ],
  };
}

async function showCurrent(i, sub) {
  await i.deferReply({ flags: EPHEMERAL });
  let data;
  try {
    data = await fetchPostings(sub.slug);
  } catch (e) {
    return i.editReply(`Couldn't reach StoaHub right now (${e.message}).`);
  }
  const wanted = data.events.filter((e) => !sub.events.length || sub.events.includes(e.name));
  const withRows = wanted.filter((e) => e.rows.length);
  if (!withRows.length) {
    return i.editReply(`No postings yet for **${data.name}** (${wanted.length} event(s) checked).\n${postingsUrl(sub.slug)}`);
  }
  const embeds = [];
  for (const e of withRows) {
    const ps = pages(e.rows);
    ps.forEach((d, n) =>
      embeds.push(
        new EmbedBuilder()
          .setTitle(trunc(ps.length > 1 ? `${e.name} (${n + 1}/${ps.length})` : e.name, 256))
          .setDescription(d)
          .setURL(postingsUrl(sub.slug)),
      ),
    );
  }
  // Discord allows 10 embeds and ~6000 characters of embed text per message.
  const messages = [];
  let cur = [];
  let size = 0;
  for (const em of embeds) {
    const len = (em.data.title?.length ?? 0) + (em.data.description?.length ?? 0);
    if (cur.length && (cur.length >= 10 || size + len > 5500)) {
      messages.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(em);
    size += len;
  }
  if (cur.length) messages.push(cur);
  const MAX_MSGS = 6;
  const more = messages.length > MAX_MSGS ? `\n(showing the first ${MAX_MSGS} messages — open the page for the rest)` : '';
  await i.editReply({ content: `**${data.name}**${more}`, embeds: messages[0] });
  for (const m of messages.slice(1, MAX_MSGS)) await i.followUp({ flags: EPHEMERAL, embeds: m });
}

/* ───────────── interaction routing ───────────── */

const expired = (i) => i.update({ content: 'That setup expired — run /config again.', components: [] });

async function onComponent(i) {
  const [ns, action, arg] = i.customId.split(':');

  if (ns === 'cfg') {
    switch (action) {
      case 'page': {
        const cal = await getCalendar().catch(() => []);
        return i.update(tournamentPanel(cal, Number(arg) || 0));
      }
      case 'url': {
        const modal = new ModalBuilder().setCustomId('cfg:urlmodal').setTitle('StoaHub tournament');
        modal.addComponents(
          row(
            new TextInputBuilder()
              .setCustomId('url')
              .setLabel('Tournament URL (or the slug)')
              .setPlaceholder('https://stoahub.org/tournament/…/postings')
              .setStyle(TextInputStyle.Short)
              .setRequired(true),
          ),
        );
        return i.showModal(modal);
      }
      case 'urlmodal': {
        await i.deferUpdate();
        const slug = slugFromInput(i.fields.getTextInputValue('url'));
        if (!slug) {
          return i.editReply({
            content: "That doesn't look like a StoaHub tournament URL.",
            components: [row(urlButton())],
          });
        }
        return chooseTournament(i, slug);
      }
      case 'tour':
        await i.deferUpdate();
        return chooseTournament(i, i.values[0]);
      case 'events':
      case 'evall': {
        const s = getSession(i.user.id);
        if (!s) return expired(i);
        await i.deferUpdate();
        s.events = action === 'events' ? i.values : [];
        return i.editReply(destPanel(s, i.inGuild()));
      }
      case 'chan': {
        const s = getSession(i.user.id);
        if (!s) return expired(i);
        await i.deferUpdate();
        const ch = await i.guild.channels.fetch(i.values[0]);
        const me = i.guild.members.me ?? (await i.guild.members.fetchMe());
        const missing = ch.permissionsFor(me)?.missing([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
        ]) ?? ['ViewChannel'];
        if (missing.length) {
          const p = destPanel(s, true);
          p.content = `⚠️ I'm missing **${missing.join(', ')}** in <#${ch.id}>. Fix that or pick another channel.\n${p.content}`;
          return i.editReply(p);
        }
        return finalize(i, ch.id);
      }
      case 'dm': {
        const s = getSession(i.user.id);
        if (!s) return expired(i);
        await i.deferUpdate();
        try {
          await i.user.send(`✅ Alerts for **${s.parsed.name}** will arrive here.`);
        } catch {
          const p = destPanel(s, i.inGuild());
          p.content = `⚠️ I can't DM you. Allow DMs from server members (Server → Privacy Settings) or pick a channel.\n${p.content}`;
          return i.editReply(p);
        }
        return finalize(i, null);
      }
    }
    return;
  }

  if (ns === 'subs') {
    if (action === 'pick') {
      const sub = store.getSub(i.values[0]);
      if (!sub || sub.userId !== i.user.id) return i.update(subsPanel(i.user.id));
      return i.update({
        content: trunc(`**${sub.tournamentName}**\n${sub.events.length ? sub.events.join(', ') : 'All events'}`, 1900),
        components: [
          row(
            new ButtonBuilder().setCustomId(`subs:show:${sub.id}`).setLabel('Show current postings').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`subs:del:${sub.id}`).setLabel('Remove').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('subs:back').setLabel('Back').setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
    }
    if (action === 'back') return i.update(subsPanel(i.user.id));
    const sub = store.getSub(arg);
    if (!sub || sub.userId !== i.user.id) return i.update(subsPanel(i.user.id));
    if (action === 'show') return showCurrent(i, sub);
    if (action === 'del') {
      store.removeSub(arg, i.user.id);
      store.prune();
      return i.update({ content: 'Removed ✅', components: [] });
    }
  }
}

client.on('interactionCreate', async (i) => {
  try {
    if (i.isChatInputCommand()) {
      await i.deferReply({ flags: EPHEMERAL });
      if (i.commandName === 'subs') return i.editReply(subsPanel(i.user.id));
      if (i.commandName === 'config') {
        const cal = await getCalendar().catch((e) => {
          console.warn('calendar failed:', e.message);
          return [];
        });
        if (!cal.length) {
          return i.editReply({
            content: "I couldn't load StoaHub's tournament list. Paste the tournament URL instead.",
            components: [row(urlButton())],
          });
        }
        return i.editReply(tournamentPanel(cal, 0));
      }
      return;
    }
    if (i.isMessageComponent() || i.isModalSubmit()) return await onComponent(i);
  } catch (err) {
    console.error(err);
    const msg = { content: 'Something went wrong. Try again in a moment.', flags: EPHEMERAL };
    try {
      if (i.deferred || i.replied) await i.followUp(msg);
      else await i.reply(msg);
    } catch { /* interaction already expired */ }
  }
});

/* ───────────── polling + notifications ───────────── */

function diffEvents(prev, data) {
  const changes = [];
  for (const ev of data.events) {
    if (ev.incomplete) continue; // a round page failed to load; don't announce a partial update
    const old = prev.events[ev.name] ?? [];
    const oldSet = new Set(old);
    const added = ev.rows.filter((r) => !oldSet.has(r));
    if (added.length) changes.push({ event: ev.name, kind: old.length ? 'updated' : 'new', rows: added });
  }
  return changes;
}

async function notify(slug, tournamentName, change) {
  const subs = store
    .allSubs()
    .filter((s) => s.slug === slug && (!s.events.length || s.events.includes(change.event)));
  if (!subs.length) return;

  const ps = pages(change.rows);
  const MAX_PAGES = 4;
  const embeds = ps.slice(0, MAX_PAGES).map((d, n) => {
    const total = Math.min(ps.length, MAX_PAGES);
    const head = change.kind === 'new' ? '📌 Postings are up' : '🔄 Postings updated';
    const e = new EmbedBuilder()
      .setTitle(trunc(`${head} · ${change.event}${total > 1 ? ` (${n + 1}/${total})` : ''}`, 256))
      .setURL(postingsUrl(slug))
      .setDescription(d)
      .setFooter({ text: trunc(tournamentName, 2000) })
      .setColor(0x5865f2);
    if (n === 0) e.setTimestamp();
    return e;
  });
  if (ps.length > MAX_PAGES) embeds[embeds.length - 1].setFooter({ text: trunc(`${tournamentName} — more on the page`, 2000) });

  for (const s of subs) {
    try {
      const target = s.channelId ? await client.channels.fetch(s.channelId) : await client.users.fetch(s.userId);
      for (let n = 0; n < embeds.length; n++) {
        const payload = { embeds: [embeds[n]] };
        if (s.channelId && n === 0) Object.assign(payload, { content: `<@${s.userId}>`, allowedMentions: { users: [s.userId] } });
        await target.send(payload);
        await sleep(300);
      }
    } catch (e) {
      console.warn(`notify failed (sub ${s.id}, code ${e.code}): ${e.message}`);
      if (e.code === 10003) store.removeSubsByChannel(s.channelId); // channel deleted
    }
  }
}

let polling = false;
async function pollOnce() {
  if (polling) return;
  polling = true;
  try {
    for (const slug of store.trackedSlugs()) {
      try {
        const data = await fetchPostings(slug);
        if (!data.events.length) {
          console.warn(`${slug}: parsed 0 events — page layout may have changed; skipping.`);
          continue;
        }
        const prev = store.getTournament(slug);
        if (!prev) {
          store.setTournament(slug, data);
          continue;
        }
        const changes = diffEvents(prev, data);
        // A transiently empty event must not erase what we already announced.
        for (const ev of data.events) {
          if (ev.incomplete || (!ev.rows.length && prev.events[ev.name]?.length)) ev.rows = prev.events[ev.name] ?? [];
        }
        store.setTournament(slug, data);
        for (const c of changes) await notify(slug, data.name, c);
      } catch (e) {
        console.warn(`poll ${slug}: ${e.message}`);
      }
      await sleep(2000);
    }
  } finally {
    polling = false;
  }
}

function schedule() {
  setTimeout(() => pollOnce().catch(console.error).finally(schedule), POLL_MS);
}

let started = false;
async function onReady() {
  if (started) return;
  started = true;
  console.log(`Logged in as ${client.user.tag}; polling every ${POLL_MS / 60_000} min`);
  await client.application.commands.set(commands.map((c) => c.toJSON()));
  pollOnce().catch(console.error).finally(schedule);
}
client.once('clientReady', onReady); // discord.js ≥14.22
client.once('ready', onReady); // older 14.x (guarded against double start)

store.load();
client.login(TOKEN);
