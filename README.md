# Soul Storm Tracker

A Discord bot to view Minecraft Dungeons II's [Soul Storms](https://minecraft.wiki/w/Dungeons_II:Soul_Storm) and receive reminders using the schedule from [dungeons.tools](https://www.dungeons.tools/2/soul-storm).

[Add to your Discord server](https://discord.com/oauth2/authorize?client_id=1560208963138748466&scope=bot%20applications.commands&permissions=51200&integration_type=0)

[Add to your account](https://discord.com/oauth2/authorize?client_id=1560208963138748466&scope=applications.commands&integration_type=1) to use commands in DMs without adding the bot to a server.

## Commands

```text
/storms
/storms timezone:America/New_York
/storm settings timezone:Europe/London
/storm remind
/storm remind location:Howling Woods
/storm remind location:Frozen Highlands repeat:true
/storm reminders
```

Settings are per-user and reminders arrive by DM.
## Deployment

Uses Node.js 22+, Wrangler, Cloudflare and a Discord application

1. fill in the .env using .env.example, creating D1 database (`wrangler d1 create mcd2-storms`) and Discord Application as needed.
2. `npm run configure` to create the Wrangler config file
3. Create the database tables using `wrangler d1 migrations apply DB --remote`
4. `npm run deploy`
5. `node scripts/seed-schedule.js` load the first schedule into database
6. `npm run setup` update credentials, register commands and generate invite link
7. set Discord application's Interaction Endpoint URL to `https://YOUR-WORKER-URL/interactions`

### Updates
```sh
npm test
npm run check
npm run configure
wrangler d1 migrations apply DB --remote
npm run deploy
```

This bot is not affiliated with Mojang, Microsoft or dungeons.tools.

Fonts and icons belong to Mojang
