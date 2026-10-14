<div align="center">

# 🗑️ Purge Bot

**Bulk-delete your own Discord messages from inside your real client.**
No token files. No Python. No "we detected a suspicious login" emails.

<p align="center"><img width="760" height="619" alt="how-to-use" src="https://github.com/user-attachments/assets/4410189b-0e79-46d9-97c1-7ed6ff5be6ee" /></p>

</div>

---

## Why this exists

Every other message deleter is a **selfbot**: it takes your account token, then hammers Discord's API from a script running outside the app. Discord's account-safety systems are built to notice exactly that, a request that doesn't match the browser or app your account normally uses. The result is the email everyone with one of these tools has seen:

<p align="center"><img width="707" height="841" alt="image" src="https://github.com/user-attachments/assets/edf601f7-21d3-4546-8aa9-31894fecd0d2" /></p>

Yes, this annoying algorithm Discord uses to invalidate your session, making you feel gaslighted that your account got disabled. Luckily, this script takes a different route. It runs **inside the Discord client you're already logged into** and sends the delete requests the same way clicking "Delete Message" does: same session, same device, same IP, same fingerprint. To Discord it is you, using Discord.

## Will this trigger the suspicious-login email?

**No.** That email fires when your account is accessed from an environment Discord doesn't recognize. Purge Bot never logs in, never handles your token in a file, and never makes a request from outside your client. There is no new login, new device, or new location for Discord to flag, because every request originates from your own running Discord tab or app.

It is not magic and it is not a loophole. It simply stops doing the one thing that got you flagged.

## Features

- **Two modes**: clean the channel you're in, or wipe your messages across your **entire account** (every server, DM, and group chat) in one run.
- **Deletes your messages** in any channel, DM, or group chat.
- **Everyone's messages** too, in servers where you have Manage Messages.
- **Fast in busy servers**: uses Discord's search to jump straight to your messages instead of reading the whole channel history.
- **Right-click any DM or channel** for a native "Delete Messages" option that targets it.
- **Order**: newest to oldest, or oldest to newest.
- **Smart pacing**: runs fast, and when Discord rate-limits it waits longer each time (+5s, up to 20s, then resets) so it rides the limit instead of fighting it. Fixed-delay mode is there if you prefer a constant speed.
- **Filters**: contains text or regex, a date range, only messages with attachments or links, skip pinned, and a "stop at this message" boundary.
- **Live progress** with a running count and ETA, a confirm step that shows what it found before deleting, and a **minimize** button so it keeps running in a small pill while you browse.
- Settings are remembered between sessions.
- A clean, Discord-native modal that opens from a trash button in the channel header.

## Install

Pick one. They have the same features.

### Option A — Tampermonkey userscript (recommended for web Discord)

Installs once and stays. Works on **web Discord** (`discord.com`) in any browser.

1. Install the [Tampermonkey](https://www.tampermonkey.net/) extension.
2. Click the Tampermonkey icon → **Create a new script**.
3. Delete the template, paste all of [`purge-bot.user.js`](./purge-bot.user.js), and press **Ctrl+S**.
4. Open `https://discord.com/app`, and you're set.

Note: make sure that you have "Allow User Scripts" enabled in your chrome://extensions/?id=dhdgffkkebhmkfjojejmpbldmpobfkfo

<p align="center"><img width="733" height="754" alt="image" src="https://github.com/user-attachments/assets/5a829a15-10c3-4510-9af3-1fa8fe107efa" /></p>

### Option B — Console paste (works in the desktop app too)

No extension. Works in the **Discord desktop app** and web Discord. You re-paste after each restart.

1. Open the channel you want to clean.
2. Press **F12** (or **Ctrl+Shift+I**) and click the **Console** tab.
3. If it warns about pasting, type `allow pasting` and press Enter.
4. Paste all of [`console-purge.js`](./console-purge.js) and press Enter.

## Usage

Open it two ways:

- Click the 🗑️ **trash button** in the channel's top toolbar, next to the call button.
- Or **right-click any DM or channel** and pick **Delete Messages** to target that one.

In the modal:

1. **Scope** — *This channel*, or *Entire account* to delete your messages everywhere.
2. **Toggles** — include everyone's messages (needs Manage Messages), delete oldest first, and Smart pacing (or switch it off for a fixed delay).
3. **Filters** (collapsed by default) — expand to narrow by text or regex, a date range, attachments, links, pinned, or a stop-at message.
4. Hit **Delete**, confirm the count it found, and watch the progress bar. Hit **Minimize** to shrink it to a pill and keep browsing while it runs.

You can also drive it from the console: `purge()`, `purge({ everyone: true })`, `purge({ global: true })`, `purge({ oldestFirst: true })`, and `stopPurge()`.

## Rate limits

Deletion is one request per message by design; that is what keeps it looking like normal use. Large channels take time. Smart pacing handles Discord's rate limits automatically, so just let it run.

## Notes & disclaimer

- Only works where you're logged in. It never asks for, stores, or transmits your token.
- Automating your account is against Discord's Terms of Service, the same as any deleter. The difference here is detection, not permission. Use it on your own account, at your own risk.
- Deleting messages is permanent. The modal shows the count it found and a confirm step before anything is removed.

> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND. THE AUTHORS ARE NOT LIABLE FOR ANY CLAIM, DAMAGES, OR OTHER LIABILITY ARISING FROM ITS USE.
