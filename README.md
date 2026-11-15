# StoaHub Postings Bot

Discord bot that watches StoaHub tournament **Postings** pages and alerts you when postings appear or change.

- `/config` — pick a tournament (list from the StoaHub calendar, or paste a URL) → pick events → pick channel or DMs
- `/subs` — see your alerts, show current postings, remove an alert

## 1. Create the Discord bot

1. https://discord.com/developers/applications → **New Application**
2. **Bot** tab → **Reset Token** → copy it (this is `DISCORD_TOKEN`; never share it). No privileged intents needed.
3. **General Information** → copy the **Application ID**
4. Invite it to your server (replace `YOUR_APP_ID`):

```
https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot%20applications.commands&permissions=19456
```

(19456 = View Channels + Send Messages + Embed Links.)

## 2. Put the code on GitHub (no terminal needed)

1. github.com → **New repository** → **Private** → create
2. **Add file → Upload files** → drag in everything from this folder (`src/`, `package.json`, `Dockerfile`, `.gitignore`) → **Commit**
3. Do **not** upload a `.env` file or your token.

## 3. Deploy on Railway (runs 24/7, off your computer)

1. https://railway.com → sign in with GitHub → **New Project → Deploy from GitHub repo** → pick the repo
2. Service → **Variables** → add `DISCORD_TOKEN` = your token
3. Service → **Settings → Volumes → Add Volume** → mount path `/data` (keeps your alerts across restarts)
4. Redeploy. **Deployments → View logs** should show `Logged in as …`.

Railway's Hobby plan is $5/month with $5 of usage included; a bot this small should fit inside that.

## Notes

- Polls each tracked tournament every 3 min (`POLL_MINUTES` to change). Alerts fire only on **new or changed** postings after you subscribe; use `/subs → Show current postings` for what's already up.
- The calendar is public but its links are login-only, so tournament URLs are built from the name + year and verified when you pick one. If one fails, use **Paste a URL instead**.
- If alerts look wrong once postings go live, the page layout probably needs a parser tweak (`src/scraper.js`).
