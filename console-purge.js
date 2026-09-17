/*
 * Purge Bot - standalone console version (no Tampermonkey needed)
 *
 * HOW TO USE
 *   1. Open the channel/DM you want to clean up.
 *   2. Open DevTools: press F12 (or Ctrl+Shift+I), click the "Console" tab.
 *   3. If it warns about pasting, type  allow pasting  and press Enter.
 *   4. Paste this whole file and press Enter.
 *   5. A trash button appears in the channel header. Click it to open the modal.
 *
 * Works in the Discord DESKTOP app and in web Discord.
 * You'll need to paste it again after reloading/restarting Discord.
 *
 * Deletes go out as same-origin fetches from your logged-in session, so they
 * look like normal in-app deletes, not like the Python selfbot that got you
 * logged out.
 */

(function () {
    "use strict";

    const w = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    const API = "/api/v9";
    const DEFAULT_DELAY_MS = 1200;
    const SMART_BASE_MS = 350;
    const RL_STEP_S = 5;
    const RL_MAX_S = 20;
    const PROGRESS_EVERY = 20;
    const AVG_DELETE_S = 0.8;

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    const _mem = {};
    function storageSet(key, val) {
        try { if (typeof GM_setValue === "function") { GM_setValue(key, val); return; } } catch (e) { }
        try { const f = document.createElement("iframe"); f.style.display = "none"; document.body.appendChild(f); f.contentWindow.localStorage.setItem(key, val); f.remove(); return; } catch (e) { }
        _mem[key] = val;
    }
    function storageGet(key) {
        try { if (typeof GM_getValue === "function") { const v = GM_getValue(key); return v || null; } } catch (e) { }
        try { const f = document.createElement("iframe"); f.style.display = "none"; document.body.appendChild(f); const v = f.contentWindow.localStorage.getItem(key); f.remove(); return v; } catch (e) { }
        return _mem[key] || null;
    }
    function saveSettings(s) { try { storageSet("purgebot", JSON.stringify(s)); } catch (e) { } }
    function loadSettings() { try { const v = storageGet("purgebot"); if (v) return JSON.parse(v); } catch (e) { } return {}; }

    let _token = null;

    // A real user token is three url-safe-base64 segments: <id>.<timestamp>.<hmac>.
    // Discord also sends OAuth "Bearer ..." and "Bot ..." tokens on /api/ requests
    // (embedded activities, connections, upsells) and plants decoy webpack modules;
    // both are rejected (401) on your messages. Every source is shape-checked so only
    // a genuine account token is ever used.
    const TOKEN_RE = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{15,}$/;
    const isToken = v => typeof v === "string" && TOKEN_RE.test(v.trim()) && !/^(bot|bearer)\s/i.test(v.trim());

    // Primary source: capture your token from Discord's own API requests. This is
    // decoy-proof and works even when Discord has cleared it from localStorage.
    (function hookToken() {
        // Keep the LATEST real token seen, not the first (an early request may carry a
        // scoped value); the shape check keeps Bearer/Bot/decoy values out.
        const grab = v => { if (isToken(v)) _token = v.trim(); };
        // Patch the PAGE's objects (unsafeWindow under Tampermonkey), not the sandbox
        // wrapper, so Discord's own requests actually pass through the hook.
        try {
            const of = w.fetch;
            w.fetch = function (input, init) {
                try {
                    const url = typeof input === "string" ? input : (input && input.url) || "";
                    if (url.indexOf("/api/") !== -1) {
                        const h = (init && init.headers) || (input && input.headers);
                        if (h) grab(h.get ? h.get("authorization") : (h.authorization || h.Authorization));
                    }
                } catch (e) { }
                return of.apply(this, arguments);
            };
        } catch (e) { }
        try {
            const XHR = (w.XMLHttpRequest && w.XMLHttpRequest.prototype) || XMLHttpRequest.prototype;
            const os = XHR.setRequestHeader;
            XHR.setRequestHeader = function (k, v) {
                try { if (/^authorization$/i.test(k)) grab(v); } catch (e) { }
                return os.apply(this, arguments);
            };
        } catch (e) { }
    })();

    // Second source: pull getToken() out of Discord's own webpack modules. Discord
    // plants decoy modules that also expose getToken but return junk, so we validate
    // the shape of everything and keep only a real token.
    function readWebpackToken() {
        try {
            const wp = w.webpackChunkdiscord_app;
            if (!wp || typeof wp.push !== "function") return null;
            let cache;
            wp.push([["pb_" + Math.random().toString(36).slice(2)], {}, req => { cache = req && req.c; }]);
            if (!cache) return null;
            for (const id in cache) {
                let exp;
                try { exp = cache[id] && cache[id].exports; } catch (e) { continue; }
                if (!exp) continue;
                for (const c of [exp, exp.default, exp.Z, exp.ZP]) {
                    if (c && typeof c.getToken === "function") {
                        let t; try { t = c.getToken(); } catch (e) { continue; }
                        if (isToken(t)) return t.trim();
                    }
                }
            }
        } catch (e) { }
        return null;
    }

    // Third source: the iframe localStorage trick (works on builds that keep the token there).
    function readIframeToken() {
        const f = document.createElement("iframe");
        f.style.display = "none";
        document.body.appendChild(f);
        let t;
        try { t = f.contentWindow.localStorage.getItem("token"); } catch (e) { }
        f.remove();
        if (t && t[0] === '"') { try { t = JSON.parse(t); } catch (e) { } }
        return isToken(t) ? t.trim() : null;
    }

    function getToken(force) {
        if (!force && isToken(_token)) return _token;
        const fresh = readWebpackToken() || readIframeToken();
        if (fresh) { _token = fresh; return _token; }
        if (force) return null;                        // re-read failed: don't reuse a rejected token
        return isToken(_token) ? _token : null;
    }

    async function apiFetch(path, opts = {}) {
        const { method = "GET", query, body } = opts;
        const qs = query ? "?" + new URLSearchParams(query) : "";
        const send = tok => {
            const headers = { authorization: tok };
            if (body) headers["content-type"] = "application/json";
            return fetch(API + path + qs, { method, headers, credentials: "include", body: body ? JSON.stringify(body) : undefined });
        };
        const token = getToken();
        if (!token) throw new Error("Couldn't read your token. Fully reload Discord (Ctrl+R) and try again.");
        let res = await send(token);
        if (res.status === 401) {
            // The token we used was rejected. Re-read from a fresh source (the first may
            // have been an early/scoped value) and try once more before giving up.
            const fresh = getToken(true);
            if (fresh && fresh !== token) res = await send(fresh);
            else throw new Error("Discord rejected the token (401). Fully reload Discord (Ctrl+R) so the script can re-read it, then run this again.");
        }
        return res;
    }

    let _myId = null;
    async function getMyId() {
        if (_myId) return _myId;
        const me = await (await apiFetch("/users/@me")).json();
        _myId = me.id;
        return _myId;
    }

    let forcedChannelId = null, forcedGuildId = null; // set when opened from a right-click menu
    let ctxChannelId = null, ctxGuildId = null;       // captured at the last right-click
    function currentContext() {
        if (forcedChannelId) return { guildId: forcedGuildId, channelId: forcedChannelId };
        const m = location.pathname.match(/channels\/(@me|\d+)\/(\d+)/);
        if (!m) return null;
        return { guildId: m[1] === "@me" ? null : m[1], channelId: m[2] };
    }
    function currentChannelId() {
        const c = currentContext();
        return c ? c.channelId : null;
    }
    function currentChannelLabel() {
        const el = document.querySelector('[class*="title_"] [aria-describedby], [class*="title_"] span');
        const t = el && el.textContent ? el.textContent.trim() : "";
        return t || "this channel";
    }
    function parseMessageId(input) {
        if (!input) return null;
        const s = String(input).trim();
        if (/^\d{15,}$/.test(s)) return s;
        const last = s.split("/").pop();
        return /^\d{15,}$/.test(last) ? last : null;
    }
    function fmtDur(sec) {
        sec = Math.max(0, Math.round(sec));
        if (sec < 60) return sec + "s";
        const m = Math.floor(sec / 60), r = sec % 60;
        if (m < 60) return m + "m " + r + "s";
        const h = Math.floor(m / 60);
        return h + "h " + (m % 60) + "m";
    }

    async function fetchPage(channelId, beforeId) {
        const query = { limit: 100 };
        if (beforeId) query.before = beforeId;
        const res = await apiFetch(`/channels/${channelId}/messages`, { query });
        if (res.status === 429) {
            const body = await res.json().catch(() => ({}));
            throw Object.assign(new Error("ratelimited-list"), { wait: (Number(body.retry_after) || 5) * 1000 + 250 });
        }
        if (!res.ok) throw new Error("Listing failed (status " + res.status + ")");
        return res.json();
    }

    function buildFilter(opts) {
        let rx = null;
        if (opts.contains && opts.regex) {
            try { rx = new RegExp(opts.contains, "i"); } catch (e) { throw new Error("Invalid regex: " + e.message); }
        }
        const sub = opts.contains && !opts.regex ? opts.contains.toLowerCase() : null;
        const newer = opts.newerThan ? Date.parse(opts.newerThan) : null;
        const older = opts.olderThan ? Date.parse(opts.olderThan) + 86400000 : null;
        return msg => {
            const content = msg.content || "";
            if (opts.skipPinned && msg.pinned) return false;
            if (opts.hasAttachments && !(msg.attachments && msg.attachments.length)) return false;
            if (opts.hasLinks && !/https?:\/\//i.test(content) && !(msg.embeds && msg.embeds.length)) return false;
            if (newer || older) {
                const ts = Date.parse(msg.timestamp);
                if (newer && ts < newer) return false;
                if (older && ts >= older) return false;
            }
            if (rx && !rx.test(content)) return false;
            if (sub && content.toLowerCase().indexOf(sub) === -1) return false;
            return true;
        };
    }

    // Route the scan: for your own messages in a guild channel, use search (jumps
    // straight to your messages instead of reading the whole channel history).
    async function scanTargets(opts, log, onScan) {
        const ctx = currentContext();
        if (!opts.everyone && ctx && ctx.guildId) return scanTargetsViaSearch(opts, ctx, log, onScan);
        return scanTargetsHistory(opts, log, onScan);
    }

    async function scanTargetsViaSearch(opts, ctx, log, onScan) {
        const me = await getMyId();
        const untilId = parseMessageId(opts.until);
        const pass = buildFilter(opts);
        const base = ctx.guildId ? `/guilds/${ctx.guildId}/messages/search` : `/channels/${ctx.channelId}/messages/search`;
        if (onScan) onScan(0, 0);
        const ids = [];
        const seen = new Set();      // dedup: buckets carry context messages that overlap across pages
        let offset = 0, done = false;
        while (!done && !aborted) {
            if (offset >= 9900) break;
            const query = { author_id: me, offset, limit: 25 };
            if (ctx.guildId) query.channel_id = ctx.channelId;
            let res;
            try { res = await apiFetch(base, { query }); }
            catch (e) { log(e.message); break; }
            if (res.status === 202) { await sleep(1500); continue; }
            if (res.status === 429) { const bd = await res.json().catch(() => ({})); await sleep((Number(bd.retry_after) || 5) * 1000 + 250); continue; }
            if (!res.ok) { log("Search failed (status " + res.status + ")"); break; }
            const data = await res.json().catch(() => null);
            const buckets = (data && Array.isArray(data.messages)) ? data.messages : [];
            if (!buckets.length) break;
            for (const bk of buckets) {
                for (const m of bk) {
                    if (!m.author || m.author.id !== me) continue;   // skip context messages from others
                    if (seen.has(m.id)) continue;                    // stale duplicate across overlapping pages
                    seen.add(m.id);
                    if (untilId && m.id === untilId) { done = true; break; }
                    if (!pass(m)) continue;
                    ids.push(m.id);
                }
                if (done) break;
            }
            if (onScan) onScan(seen.size, ids.length);
            offset += 25;
            if (buckets.length < 25) break;                          // fewer than a full page of hits: end
        }
        if (opts.oldestFirst) ids.reverse();
        return { channelId: ctx.channelId, ids };
    }

    async function scanTargetsHistory(opts, log, onScan) {
        const channelId = currentChannelId();
        if (!channelId) { log("Open a channel or DM first."); return { channelId: null, ids: [] }; }

        let authorId = null;
        if (!opts.everyone) authorId = await getMyId();

        const untilId = parseMessageId(opts.until);
        const pass = buildFilter(opts);

        if (onScan) onScan(0, 0); else log("Scanning messages");
        const ids = [];
        let beforeId, done = false, seen = 0;
        while (!done && !aborted) {
            let page;
            try { page = await fetchPage(channelId, beforeId); }
            catch (e) {
                if (e.wait) { log(`Rate limited while scanning, waiting ${Math.round(e.wait / 1000)}s`); await sleep(e.wait); continue; }
                log(e.message); break;
            }
            if (!page.length) break;
            for (const msg of page) {
                if (untilId && msg.id === untilId) { done = true; break; }
                seen++;
                if (authorId && !(msg.author && msg.author.id === authorId)) continue;
                if (!pass(msg)) continue;
                ids.push(msg.id);
            }
            if (onScan) onScan(seen, ids.length);
            if (page.length < 100) break;
            beforeId = page[page.length - 1].id;
        }
        if (opts.oldestFirst) ids.reverse();
        return { channelId, ids, seen };
    }

    async function deleteTargets(channelId, ids, opts, { onProgress, log }) {
        const smart = opts.smart !== false;
        const baseDelay = smart ? SMART_BASE_MS : (Number(opts.delayMs) > 0 ? Number(opts.delayMs) : DEFAULT_DELAY_MS);
        const jitter = () => baseDelay + Math.random() * baseDelay * 0.4;

        const rl = { hits: 0 };
        let deleted = 0, skipped = 0;
        const start = Date.now();
        for (let i = 0; i < ids.length; i++) {
            if (aborted) break;
            const r = await deleteOne(channelId, ids[i], rl, log);
            r === "deleted" ? deleted++ : skipped++;
            const doneCount = deleted + skipped;
            const elapsed = (Date.now() - start) / 1000;
            const rate = doneCount / elapsed;
            const eta = rate > 0 ? (ids.length - doneCount) / rate : (ids.length - doneCount) * AVG_DELETE_S;
            if (onProgress) onProgress(doneCount, ids.length, eta);
            if (deleted && deleted % PROGRESS_EVERY === 0) log(`${deleted}/${ids.length} deleted (${skipped} skipped)`);
            await sleep(jitter());
        }
        return { deleted, skipped };
    }

    async function deleteOne(channelId, messageId, rl, log) {
        let netFails = 0, attempts = 0;
        while (true) {
            if (aborted) return "skipped";
            if (++attempts > 12) return "skipped"; // give up on one stubborn message
            let res;
            try {
                res = await apiFetch(`/channels/${channelId}/messages/${messageId}`, { method: "DELETE" });
            } catch (e) {
                if (e && /token/i.test(e.message)) throw e; // token gone: abort the run
                if (++netFails >= 4) return "skipped";       // transient network error
                await sleep(1500);
                continue;
            }
            if (res.status === 204 || res.status === 404) return "deleted";
            if (res.status === 403) return "skipped";
            if (res.status === 429) {
                rl.hits++;
                const stepped = Math.min(RL_STEP_S * rl.hits, RL_MAX_S);
                const body = await res.json().catch(() => ({}));
                const retry = Number(body.retry_after);
                const wait = Math.max(stepped * 1000, retry > 0 ? retry * 1000 + 250 : 0);
                log(`Rate limited, waiting ${Math.round(wait / 1000)}s`);
                await sleep(wait);
                if (stepped >= RL_MAX_S) rl.hits = 0;
                continue;
            }
            return "skipped";
        }
    }

    let aborted = false;
    function stopPurge() { aborted = true; }

    // ----- global (account-wide) mode: delete your messages everywhere via search
    const GLOBAL_DELETABLE = [0, 19, 20, 21, 23];
    async function globalSearchPage(me, offset, log) {
        const body = { tabs: { messages: { sort_by: "timestamp", sort_order: "desc", author_id: [me], limit: 25, offset } }, track_exact_total_hits: true };
        while (!aborted) {
            const res = await apiFetch("/users/@me/messages/search/tabs", { method: "POST", body });
            if (res.status === 202) { await sleep(1500); continue; }
            if (res.status === 429) {
                const b = await res.json().catch(() => ({}));
                const w = (Number(b.retry_after) || 10) * 1000 + 250;
                if (log) log(`Search rate limited, waiting ${Math.round(w / 1000)}s`);
                await sleep(w); continue;
            }
            if (!res.ok) return { total: 0, msgs: [] };
            const data = await res.json().catch(() => null);
            const tab = data && data.tabs && data.tabs.messages;
            const msgs = [];
            if (tab && Array.isArray(tab.messages)) for (const bucket of tab.messages) for (const m of bucket) msgs.push(m);
            return { total: tab ? tab.total_results : 0, msgs };
        }
        return { total: 0, msgs: [] };
    }

    // The search can transiently report 0 (reindexing) or on a failed request; never
    // trust a single zero — retry a few times before believing it.
    async function remainingTotal(me, log) {
        let total = 0;
        for (let i = 0; i < 4 && !aborted; i++) {
            total = (await globalSearchPage(me, 0, log)).total;
            if (total > 0) return total;
            await sleep(1800);
        }
        return total;
    }

    async function globalCount() {
        const me = await getMyId();
        return remainingTotal(me, null);
    }

    async function globalPurge(opts, { onProgress, onScan, log }) {
        const me = await getMyId();
        const smart = opts.smart !== false;
        const baseDelay = smart ? SMART_BASE_MS : (Number(opts.delayMs) > 0 ? Number(opts.delayMs) : DEFAULT_DELAY_MS);
        const jitter = () => baseDelay + Math.random() * baseDelay * 0.4;
        const rl = { hits: 0 };
        const seen = new Set();
        let offset = 0, deleted = 0, skipped = 0;
        let remaining = await remainingTotal(me, log);
        const initialTotal = remaining;
        const start = Date.now();
        let stall = 0, lastRemaining = Infinity;
        const report = () => {
            if (!onProgress) return;
            const denom = Math.max(initialTotal, deleted + remaining, deleted);
            const elapsed = (Date.now() - start) / 1000;
            const rate = deleted / elapsed;
            const eta = rate > 0 ? Math.max(0, denom - deleted) / rate : (denom - deleted) * AVG_DELETE_S;
            onProgress(deleted, denom, eta);
        };
        report();
        while (!aborted) {
            if (offset >= 9900) offset = 0;
            const page = await globalSearchPage(me, offset, log);
            let progressed = false;
            for (const m of page.msgs) {
                if (aborted) break;
                if (seen.has(m.id)) continue; // stale duplicate from a lagging index
                seen.add(m.id);
                const deletable = m.author && m.author.id === me && m.type !== 3 && GLOBAL_DELETABLE.includes(m.type);
                if (!deletable) { skipped++; continue; }
                const r = await deleteOne(m.channel_id, m.id, rl, log);
                if (r === "deleted") { deleted++; progressed = true; report(); } else skipped++;
                await sleep(jitter());
            }
            if (onScan) onScan(seen.size, deleted);
            if (progressed) { offset = 0; stall = 0; continue; }
            // No new deletions this page. Ask the search how many of your messages it
            // still reports, and only stop once that count actually stops going down.
            offset += 25;
            remaining = await remainingTotal(me, log);
            report();
            if (remaining <= 0) break;                       // nothing left
            if (remaining < lastRemaining) stall = 0; else stall++;
            lastRemaining = remaining;
            // Be very patient while a lot still remains (reindex lag / deep offsets);
            // give up sooner only when just a few remain (likely undeletable system messages).
            const cap = remaining > 20 ? 70 : 12;
            if (stall >= cap) break;
            await sleep(remaining > 20 ? 5000 : 3000);
        }
        return { deleted, skipped, total: initialTotal, remaining };
    }
    w.globalPurge = globalPurge;
    w.globalCount = globalCount;

    async function purge(opts = {}) {
        aborted = false;
        const log = typeof opts.onLog === "function" ? opts.onLog : (m => console.log("[PurgeBot] " + m));
        if (opts.global) {
            const total = await globalCount();
            log(`Found ${total} message(s) across your whole account.`);
            if (opts.dryRun) { log(`[DRY RUN] Would delete ${total}. Nothing deleted.`); return { total }; }
            if (!total) { log("Nothing to delete."); return { deleted: 0, skipped: 0 }; }
            const gres = await globalPurge(opts, { log });
            log(`${aborted ? "Stopped. " : "Done. "}Deleted ${gres.deleted} everywhere (skipped ${gres.skipped}).`);
            if (!aborted && gres.remaining > 0) log(`~${gres.remaining} may still be indexing; run purge({ global: true }) again in a minute.`);
            return gres;
        }
        let scan;
        try { scan = await scanTargets(opts, log, (seen, matched) => { if (seen && seen % 500 === 0) log(`Scanning: ${seen} checked, ${matched} matching`); }); } catch (e) { log(e.message); return; }
        if (!scan.channelId) return;
        log(`Found ${scan.ids.length} message(s) to ${opts.dryRun ? "count" : "delete"}, order: ${opts.oldestFirst ? "oldest to newest" : "newest to oldest"}.`);
        if (opts.dryRun) { log(`[DRY RUN] Would delete ${scan.ids.length}. Nothing deleted.`); return scan; }
        if (!scan.ids.length) { log("Nothing to delete."); return scan; }
        const res = await deleteTargets(scan.channelId, scan.ids, opts, { log });
        log(`${aborted ? "Stopped. " : "Done. "}Deleted ${res.deleted} of ${scan.ids.length} (skipped ${res.skipped}).`);
        return res;
    }

    w.purge = purge;
    w.stopPurge = stopPurge;
    w.purgeScan = scanTargets;
    w.purgeDelete = deleteTargets;

    const STYLE_ID = "purgebot-style";
    function ensureStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const s = document.createElement("style");
        s.id = STYLE_ID;
        s.textContent = `
        .pb-overlay{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:oklab(0 0 0 / 0.721569);font-family:"gg sans","Noto Sans",Helvetica,Arial,sans-serif;animation:pb-fade .15s ease}
        .pb-modal{width:440px;max-width:calc(100vw - 32px);background:oklab(0.26239 0.00252313 -0.00890189);color:#dbdee1;border-radius:12px;box-shadow:0 0 0 1px hsl(240 20% 0.98% / .15),0 8px 16px hsl(0 0% 0% / .24);display:flex;flex-direction:column;max-height:86vh;animation:pb-pop .2s cubic-bezier(.16,.84,.3,1.06)}
        @keyframes pb-fade{from{opacity:0}to{opacity:1}}
        @keyframes pb-fadeout{from{opacity:1}to{opacity:0}}
        @keyframes pb-pop{from{opacity:0;transform:scale(.85)}to{opacity:1;transform:scale(1)}}
        @keyframes pb-popout{from{opacity:1;transform:scale(1)}to{opacity:0;transform:scale(.85)}}
        @keyframes pb-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
        .pb-overlay.pb-closing{animation:pb-fadeout .16s ease forwards}
        .pb-overlay.pb-closing .pb-modal{animation:pb-popout .16s cubic-bezier(.4,0,.85,.35) forwards}
        .pb-head{position:relative;padding:16px;flex:none}
        .pb-title{font-size:20px;font-weight:600;line-height:24px;color:#f2f3f5;display:flex;align-items:center;gap:8px}
        .pb-sub{margin-top:4px;font-size:13px;color:#b5bac1}
        .pb-sub b{color:#dbdee1}
        .pb-x{position:absolute;top:16px;right:16px;width:24px;height:24px;border:none;background:none;color:#b5bac1;cursor:pointer;display:flex;align-items:center;justify-content:center;border-radius:4px}
        .pb-x:hover{color:#f2f3f5}
        .pb-body{padding:0 16px 16px;overflow-y:auto;display:flex;flex-direction:column;gap:16px}
        .pb-body::-webkit-scrollbar{width:8px}.pb-body::-webkit-scrollbar-thumb{background:#1a1b1e;border-radius:4px}.pb-body::-webkit-scrollbar-track{background:transparent}
        .pb-label{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.02em;color:#b5bac1;margin-bottom:8px;display:block}
        .pb-seg{display:flex;gap:4px;background:hsl(240 5.26% 7.45%);padding:4px;border-radius:8px}
        .pb-seg button{flex:1;padding:8px;border-radius:5px;border:none;background:transparent;color:#b5bac1;cursor:pointer;font-size:13px;font-weight:500;transition:background .12s,color .12s}
        .pb-seg button:hover{background:rgba(255,255,255,.06);color:#dbdee1}
        .pb-seg button.pb-on{background:#5865f2;color:#fff}
        .pb-seg button.pb-on:hover{background:#5865f2}
        .pb-input,.pb-date{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid hsl(240 4% 60% / .12);background:hsl(240 5.26% 7.45%);color:#dbdee1;font-size:14px;font-family:inherit}
        .pb-input::placeholder{color:#87898c}
        .pb-input:focus,.pb-date:focus{outline:none;border-color:#5865f2}
        .pb-date{color-scheme:dark}
        .pb-range-row{display:flex;align-items:center;gap:10px}
        .pb-range-row input[type=range]{flex:1;accent-color:#5865f2}
        .pb-range-val{width:74px;text-align:right;font-variant-numeric:tabular-nums;color:#f2f3f5;font-size:13px}
        .pb-note{font-size:12px;color:#949ba4;margin-top:6px}
        .pb-warn{font-size:12px;color:#f5a3a5;background:rgba(242,63,66,.1);border:1px solid rgba(242,63,66,.25);border-radius:6px;padding:8px 10px;margin-top:8px;line-height:1.45}
        .pb-field-row{display:flex;gap:8px}
        .pb-field-row>div{flex:1}
        .pb-mini{font-size:11px;font-weight:600;color:#949ba4;text-transform:uppercase;margin-bottom:4px;display:block}
        .pb-opts{display:flex;flex-direction:column;gap:6px}
        .pb-tog{display:flex;align-items:center;gap:10px;font-size:14px;color:#dbdee1;cursor:pointer;user-select:none}
        .pb-tog+.pb-tog{margin-top:2px}
        .pb-switch{position:relative;width:40px;height:24px;flex:none}
        .pb-switch input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer}
        .pb-switch .pb-track{position:absolute;inset:0;background:#80848e;border-radius:12px;transition:background .15s}
        .pb-switch .pb-knob{position:absolute;top:4px;left:4px;width:16px;height:16px;background:#fff;border-radius:50%;transition:transform .15s}
        .pb-switch input:checked~.pb-track{background:#23a55a}
        .pb-switch input:checked~.pb-knob{transform:translateX(16px)}
        .pb-hr{height:1px;background:hsl(240 4% 60% / .12);border:none;margin:0}
        .pb-collapse-head{display:flex;align-items:center;gap:8px;width:100%;background:none;border:none;cursor:pointer;padding:0;color:#b5bac1}
        .pb-collapse-head:hover .pb-label,.pb-collapse-head:hover .pb-chev{color:#dbdee1}
        .pb-chev{color:#b5bac1;transition:transform .15s;flex:none}
        .pb-collapse.pb-open .pb-chev{transform:rotate(90deg)}
        .pb-badge{font-size:11px;background:#5865f2;color:#fff;border-radius:8px;padding:1px 7px;font-weight:600}
        .pb-collapse-body{margin-top:12px}
        .pb-log{flex:none;background:hsl(240 5.26% 7.45%);border-radius:4px;padding:8px 10px;height:84px;min-height:84px;overflow:auto;font-family:Consolas,"Courier New",monospace;font-size:12px;line-height:1.5;color:#b5bac1;white-space:pre-wrap}
        .pb-progwrap{flex:none;display:none;flex-direction:column;gap:6px}
        .pb-progbar{height:8px;background:hsl(240 5.26% 7.45%);border-radius:4px;overflow:hidden}
        .pb-progfill{height:100%;width:0;background:linear-gradient(90deg,#5865f2,#818cf8,#5865f2);background-size:200% 100%;animation:pb-shimmer 1.6s linear infinite;transition:width .25s;border-radius:4px}
        .pb-progtext{font-size:12px;color:#b5bac1;font-variant-numeric:tabular-nums}
        .pb-foot{display:flex;align-items:center;gap:12px;padding:16px;background:oklab(0.26239 0.00252313 -0.00890189);border-radius:0 0 12px 12px;flex:none}
        .pb-foot .pb-spacer{flex:1}
        .pb-btn{min-height:38px;padding:2px 16px;border-radius:8px;border:none;cursor:pointer;font-size:14px;font-weight:500;transition:background .12s}
        .pb-btn:disabled{opacity:.5;cursor:not-allowed}
        .pb-primary{background:#5865f2;color:#fff}.pb-primary:hover{background:#4752c4}
        .pb-danger{background:#da373c;color:#fff}.pb-danger:hover{background:#a12828}
        .pb-link{background:none;color:#dbdee1}.pb-link:hover{text-decoration:underline}
        .pb-stopbtn{background:#4e5058;color:#fff}.pb-stopbtn:hover{background:#6d6f78}
        .pb-pill{position:fixed;bottom:20px;right:20px;z-index:100001;width:264px;background:oklab(0.26239 0.00252313 -0.00890189);color:#dbdee1;border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,.6);padding:12px 14px;font-family:"gg sans","Noto Sans",Helvetica,Arial,sans-serif;display:none;cursor:pointer}
        .pb-pill,.pb-pill *{text-transform:none !important;letter-spacing:normal !important}
        .pb-mini-top{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:#f2f3f5;margin-bottom:8px}
        .pb-mini-ic{flex:none;line-height:0}
        .pb-mini-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .pb-mini-stop{background:#4e5058;color:#fff;border:none;border-radius:3px;padding:4px 10px;font-size:12px;font-weight:600;cursor:pointer}
        .pb-mini-stop:hover{background:#6d6f78}
        .pb-mini-bar{height:6px;background:hsl(240 5.26% 7.45%);border-radius:3px;overflow:hidden;margin-bottom:6px}
        .pb-mini-fill{height:100%;width:0;background:linear-gradient(90deg,#5865f2,#818cf8,#5865f2);background-size:200% 100%;animation:pb-shimmer 1.6s linear infinite;transition:width .25s;border-radius:3px}
        .pb-mini-text{font-size:12px;color:#b5bac1;font-variant-numeric:tabular-nums}
        .pb-mini-hint{font-size:11px;color:#87898c;margin-top:4px}
        .pb-tip{position:fixed;z-index:100002;display:none;box-sizing:border-box;max-width:200px;background:oklab(0.26239 0.00252313 -0.00890189);color:oklab(0.952693 0.000792831 -0.00253612);font-family:"gg sans","Noto Sans","Helvetica Neue",Helvetica,Arial,sans-serif;font-size:14px;font-weight:500;line-height:1.28572;padding:8px 12px;border-radius:8px;box-shadow:oklab(0.678923 0.00325415 -0.0111644 / 0.121569) 0 0 0 1px inset, rgba(0,0,0,0.24) 0 12px 24px 0;pointer-events:none}
        .pb-tip-caret{position:absolute;top:-9px;left:50%;transform:translateX(-50%);width:16px;height:10px;line-height:0}
        .pb-tip-caret svg{display:block;transform:scaleY(-1)}
        .pb-tip-caret path{fill:oklab(0.26239 0.00252313 -0.00890189)}
        .purgebot-ctx{cursor:pointer}
        `;
        document.head.appendChild(s);
    }

    function switchEl(cls, checked) {
        return `<span class="pb-switch"><input type="checkbox" class="${cls}"${checked ? " checked" : ""}><span class="pb-track"></span><span class="pb-knob"></span></span>`;
    }

    let modalEl = null;
    let activeModal = null;
    function openModal() {
        if (activeModal) { activeModal.expand(); return; }
        ensureStyles();
        if (modalEl) modalEl.remove();
        document.querySelectorAll(".pb-overlay, .pb-pill").forEach(e => e.remove()); // clear any element still animating out

        const saved = loadSettings();
        const st = {
            everyone: false,
            oldestFirst: !!saved.oldestFirst,
            smart: saved.smart !== false,
            global: false,
        };
        let running = false;

        const overlay = document.createElement("div");
        overlay.className = "pb-overlay";
        overlay.innerHTML = `
        <div class="pb-modal" role="dialog" aria-label="Purge Bot">
            <div class="pb-head">
                <div class="pb-title"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" style="flex:none"><path fill="currentColor" d="${TRASH_PATH}"></path></svg>Purge Bot</div>
                <button class="pb-x" title="Close" aria-label="Close"><svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path fill="currentColor" d="M17.3 18.7a1 1 0 0 0 1.4-1.4L13.42 12l5.3-5.3a1 1 0 0 0-1.42-1.4L12 10.58l-5.3-5.3a1 1 0 0 0-1.4 1.42L10.58 12l-5.3 5.3a1 1 0 1 0 1.42 1.4L12 13.42l5.3 5.3Z"/></svg></button>
            </div>
            <div class="pb-body">
                <div>
                    <span class="pb-label">Scope</span>
                    <div class="pb-seg">
                        <button data-s="chan" class="pb-on">This channel</button>
                        <button data-s="all">Entire account</button>
                    </div>
                    <div class="pb-warn pb-globalwarn" style="display:none">Deletes ALL your messages across every server, DM and group chat. This cannot be undone.</div>
                </div>
                <hr class="pb-hr">
                <div class="pb-opts">
                    <label class="pb-tog pb-chanonly">${switchEl("pb-everyone", false)} Include everyone's messages</label>
                    <label class="pb-tog pb-chanonly">${switchEl("pb-oldest", !!saved.oldestFirst)} Delete oldest first</label>
                    <label class="pb-tog">${switchEl("pb-smart", st.smart)} Smart pacing</label>
                    <div class="pb-note pb-smartnote" style="display:${st.smart ? "block" : "none"}">Fast, and automatically waits longer (+5s each time, up to 20s) whenever Discord rate-limits, then resets.</div>
                    <div class="pb-fixedwrap" style="display:${st.smart ? "none" : "block"};margin-top:8px">
                        <div class="pb-range-row">
                            <input type="range" class="pb-delay" min="300" max="4000" step="100" value="${Number(saved.delayMs) || DEFAULT_DELAY_MS}">
                            <span class="pb-range-val">${Number(saved.delayMs) || DEFAULT_DELAY_MS} ms</span>
                        </div>
                    </div>
                </div>
                <hr class="pb-hr pb-chanonly">
                <div class="pb-collapse pb-chanonly">
                    <button type="button" class="pb-collapse-head">
                        <svg class="pb-chev" width="16" height="16" viewBox="0 0 24 24" fill="none"><path fill="currentColor" d="M8.3 5.7a1 1 0 0 0 0 1.4l4.9 4.9-4.9 4.9a1 1 0 1 0 1.4 1.4l5.6-5.6a1 1 0 0 0 0-1.4L9.7 5.7a1 1 0 0 0-1.4 0Z"/></svg>
                        <span class="pb-label" style="margin:0">Filters</span>
                        <span class="pb-badge" style="display:none"></span>
                    </button>
                    <div class="pb-collapse-body" style="display:none">
                        <span class="pb-mini">Stop at message (kept)</span>
                        <input class="pb-input pb-until" placeholder="Paste a message link or id" value="${(saved.until || "").replace(/"/g, "&quot;")}" style="margin-bottom:8px">
                        <input class="pb-input pb-contains" placeholder="Contains text" value="${(saved.contains || "").replace(/"/g, "&quot;")}" style="margin-bottom:8px">
                        <label class="pb-tog" style="margin-bottom:10px">${switchEl("pb-regex", !!saved.regex)} Treat as regular expression</label>
                        <div class="pb-field-row" style="margin-bottom:10px">
                            <div><span class="pb-mini">Newer than</span><input type="date" class="pb-date pb-newer" value="${saved.newerThan || ""}"></div>
                            <div><span class="pb-mini">Older than</span><input type="date" class="pb-date pb-older" value="${saved.olderThan || ""}"></div>
                        </div>
                        <label class="pb-tog">${switchEl("pb-hasatt", !!saved.hasAttachments)} Only messages with attachments</label>
                        <label class="pb-tog">${switchEl("pb-haslink", !!saved.hasLinks)} Only messages with links</label>
                        <label class="pb-tog">${switchEl("pb-skippin", saved.skipPinned !== false)} Skip pinned messages</label>
                    </div>
                </div>
                <div class="pb-log" aria-live="polite"></div>
                <div class="pb-progwrap">
                    <div class="pb-progbar"><div class="pb-progfill"></div></div>
                    <div class="pb-progtext"></div>
                </div>
            </div>
            <div class="pb-foot">
                <div class="pb-spacer"></div>
                <button class="pb-btn pb-link pb-min" style="display:none">Minimize</button>
                <button class="pb-btn pb-link pb-cancel">Cancel</button>
                <button class="pb-btn pb-stopbtn pb-stop" style="display:none">Stop</button>
                <button class="pb-btn pb-primary pb-start">Delete mine</button>
            </div>
        </div>`;

        const $ = sel => overlay.querySelector(sel);
        const $$ = sel => [...overlay.querySelectorAll(sel)];

        function seg(selector, onPick) {
            $$(selector).forEach(btn => btn.onclick = () => {
                if (running) return;
                $$(selector).forEach(b => b.classList.remove("pb-on"));
                btn.classList.add("pb-on");
                onPick(btn);
                refreshPrimary();
            });
        }
        seg('[data-s]', b => {
            st.global = b.dataset.s === "all";
            $$(".pb-chanonly").forEach(el => el.style.display = st.global ? "none" : "");
            $(".pb-globalwarn").style.display = st.global ? "block" : "none";
        });
        const everyoneSw = $(".pb-everyone"), oldestSw = $(".pb-oldest"), smartSw = $(".pb-smart");
        everyoneSw.onchange = () => { st.everyone = everyoneSw.checked; refreshPrimary(); };
        oldestSw.onchange = () => { st.oldestFirst = oldestSw.checked; };
        smartSw.onchange = () => {
            st.smart = smartSw.checked;
            $(".pb-fixedwrap").style.display = st.smart ? "none" : "block";
            $(".pb-smartnote").style.display = st.smart ? "block" : "none";
        };

        const delay = $(".pb-delay");
        delay.oninput = () => { $(".pb-range-val").textContent = delay.value + " ms"; };

        const startBtn = $(".pb-start"), stopBtn = $(".pb-stop"), cancelBtn = $(".pb-cancel");
        const logBox = $(".pb-log");
        const progWrap = $(".pb-progwrap"), progFill = $(".pb-progfill"), progText = $(".pb-progtext");

        const logLine = msg => { const d = document.createElement("div"); d.textContent = msg; logBox.appendChild(d); logBox.scrollTop = logBox.scrollHeight; };
        let scanLineEl = null;
        const scanStatus = text => {
            if (!scanLineEl) { scanLineEl = document.createElement("div"); logBox.appendChild(scanLineEl); }
            scanLineEl.textContent = text;
            logBox.scrollTop = logBox.scrollHeight;
        };

        const minBtn = $(".pb-min");
        let minimized = false;
        const widget = document.createElement("div");
        widget.className = "pb-pill";
        widget.innerHTML = `
            <div class="pb-mini-top"><span class="pb-mini-ic"><svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path fill="currentColor" d="${TRASH_PATH}"></path></svg></span><span class="pb-mini-title">Purging</span><button class="pb-mini-stop">Stop</button></div>
            <div class="pb-mini-bar"><div class="pb-mini-fill"></div></div>
            <div class="pb-mini-text"></div>
            <div class="pb-mini-hint">Click to reopen</div>`;
        const wTitle = widget.querySelector(".pb-mini-title");
        const wFill = widget.querySelector(".pb-mini-fill");
        const wText = widget.querySelector(".pb-mini-text");
        const wStop = widget.querySelector(".pb-mini-stop");
        document.body.appendChild(widget);
        function minimize() { minimized = true; overlay.style.display = "none"; widget.style.display = "block"; }
        function expand() { minimized = false; widget.style.display = "none"; overlay.style.display = "flex"; }
        widget.onclick = expand;
        wStop.onclick = e => { e.stopPropagation(); stopPurge(); logLine("Stopping"); wText.textContent = "Stopping"; };
        minBtn.onclick = minimize;

        function refreshPrimary() {
            if (running) return;
            const danger = st.global || st.everyone;
            startBtn.classList.toggle("pb-danger", danger);
            startBtn.classList.toggle("pb-primary", !danger);
            startBtn.textContent = st.global ? "Delete everywhere" : (st.everyone ? "Delete everyone's" : "Delete mine");
        }
        refreshPrimary();

        const collapse = $(".pb-collapse"), collBody = $(".pb-collapse-body"), badge = $(".pb-badge");
        function setOpen(open) {
            collapse.classList.toggle("pb-open", open);
            collBody.style.display = open ? "block" : "none";
        }
        function updateBadge() {
            let n = 0;
            if ($(".pb-until").value.trim()) n++;
            if ($(".pb-contains").value.trim()) n++;
            if ($(".pb-newer").value) n++;
            if ($(".pb-older").value) n++;
            if ($(".pb-hasatt").checked) n++;
            if ($(".pb-haslink").checked) n++;
            badge.textContent = n;
            badge.style.display = n ? "inline-block" : "none";
        }
        $(".pb-collapse-head").onclick = () => setOpen(!collapse.classList.contains("pb-open"));
        collBody.addEventListener("input", updateBadge);
        collBody.addEventListener("change", updateBadge);
        updateBadge();
        const filtersActive = saved.until || saved.contains || saved.newerThan || saved.olderThan || saved.hasAttachments || saved.hasLinks;
        setOpen(!!filtersActive);

        function readOpts() {
            return {
                everyone: st.everyone,
                oldestFirst: st.oldestFirst,
                smart: st.smart,
                delayMs: Number(delay.value),
                until: $(".pb-until").value.trim(),
                contains: $(".pb-contains").value.trim(),
                regex: $(".pb-regex").checked,
                newerThan: $(".pb-newer").value,
                olderThan: $(".pb-older").value,
                hasAttachments: $(".pb-hasatt").checked,
                hasLinks: $(".pb-haslink").checked,
                skipPinned: $(".pb-skippin").checked,
                global: st.global,
                onLog: logLine,
            };
        }

        function lockInputs(lock) {
            $$(".pb-seg button, .pb-body input").forEach(el => el.disabled = lock);
        }

        let closing = false, cancelConfirm = null;
        function close() {
            if (closing) return;
            closing = true;
            if (cancelConfirm) cancelConfirm();
            widget.remove(); modalEl = null; activeModal = null; forcedChannelId = null; forcedGuildId = null; if (running) stopPurge();
            overlay.classList.add("pb-closing");
            const done = () => overlay.remove();
            overlay.addEventListener("animationend", done, { once: true });
            setTimeout(done, 260);
        }
        $(".pb-x").onclick = close;
        cancelBtn.onclick = close;
        overlay.addEventListener("mousedown", e => { if (e.target === overlay) { if (running) minimize(); else close(); } });

        async function run() {
            if (running) return;
            aborted = false;
            const opts = readOpts();
            saveSettings(opts);

            running = true;
            lockInputs(true);
            startBtn.disabled = true;
            cancelBtn.style.display = "none";
            stopBtn.style.display = "";
            stopBtn.disabled = false;
            minBtn.style.display = "";
            progWrap.style.display = "none";
            progFill.style.width = "0";

            if (opts.global) { await runGlobal(opts); return; }

            let scan;
            try {
                scan = await scanTargets(opts, logLine, (seen, matched) => {
                    scanStatus(seen ? `Scanning: ${seen} messages checked, ${matched} matching` : "Scanning messages");
                    if (minimized) { wTitle.textContent = "Scanning"; wFill.style.width = "0"; wText.textContent = seen ? `${seen} checked, ${matched} found` : "Starting"; }
                });
            }
            catch (e) { logLine(e.message); return finish(); }
            if (!scan.channelId) return finish();
            scanLineEl = null;
            logLine(`Found ${scan.ids.length} message(s) matching your filters.`);
            if (!scan.ids.length) { logLine("Nothing to delete."); return finish(); }

            const ok = await confirmDelete(scan.ids.length);
            if (!ok) { logLine("Cancelled."); return finish(); }

            progWrap.style.display = "flex";
            wTitle.textContent = "Purging";
            const total = scan.ids.length;
            let res;
            try {
                res = await deleteTargets(scan.channelId, scan.ids, opts, {
                    log: logLine,
                    onProgress: (done, tot, eta) => {
                        const pct = (done / tot * 100) + "%";
                        const txt = `${done} / ${tot}  ·  ~${fmtDur(eta)} left`;
                        progFill.style.width = pct; progText.textContent = txt;
                        wFill.style.width = pct; wText.textContent = txt;
                    },
                });
            } catch (e) { logLine(e.message || String(e)); return finish(); }
            logLine(`${aborted ? "Stopped. " : "Done. "}Deleted ${res.deleted} of ${total} (skipped ${res.skipped}).`);
            if (minimized) {
                wStop.style.display = "none";
                wTitle.textContent = aborted ? "Stopped" : "Done";
                wFill.style.width = "100%";
                wText.textContent = `Deleted ${res.deleted} of ${total}`;
                setTimeout(() => { if (minimized) close(); }, 6000);
            }
            finish();
        }

        async function runGlobal(opts) {
            scanStatus("Searching your messages across all servers and DMs");
            let total;
            try { total = await globalCount(); }
            catch (e) { logLine(e.message); return finish(); }
            scanLineEl = null;
            logLine(`Found ${total} message(s) across your whole account.`);
            if (!total) { logLine("Nothing found. If you just ran a purge, Discord's search is still updating; wait a minute and try again."); return finish(); }
            const ok = await confirmDelete(total);
            if (!ok) { logLine("Cancelled."); return finish(); }
            progWrap.style.display = "flex";
            wTitle.textContent = "Purging";
            let res;
            try {
                res = await globalPurge(opts, {
                    log: logLine,
                    onProgress: (done, tot, eta) => {
                        const pct = (tot ? done / tot * 100 : 0) + "%";
                        const txt = `${done} / ${tot}  ·  ~${fmtDur(eta)} left`;
                        progFill.style.width = pct; progText.textContent = txt;
                        wFill.style.width = pct; wText.textContent = txt;
                    },
                });
            } catch (e) { logLine(e.message || String(e)); return finish(); }
            logLine(`${aborted ? "Stopped. " : "Done. "}Deleted ${res.deleted} everywhere (skipped ${res.skipped}).`);
            if (!aborted && res.remaining > 0) logLine(`~${res.remaining} may still be indexing on Discord's side. Run "Entire account" again in a minute to clear the rest.`);
            if (minimized) {
                wStop.style.display = "none";
                wTitle.textContent = aborted ? "Stopped" : "Done";
                wFill.style.width = "100%";
                wText.textContent = `Deleted ${res.deleted}`;
                setTimeout(() => { if (minimized) close(); }, 6000);
            }
            finish();
        }

        function finish() {
            running = false;
            lockInputs(false);
            startBtn.disabled = false;
            stopBtn.style.display = "none";
            minBtn.style.display = "none";
            cancelBtn.style.display = "";
            refreshPrimary();
        }

        function confirmDelete(n) {
            return new Promise(resolve => {
                stopBtn.style.display = "none";
                startBtn.style.display = "none";
                const confirmBtn = document.createElement("button");
                confirmBtn.className = "pb-btn pb-danger";
                confirmBtn.textContent = `Delete ${n} ${n === 1 ? "Message" : "Messages"}`;
                const backBtn = document.createElement("button");
                backBtn.className = "pb-btn pb-link";
                backBtn.textContent = "Back";
                $(".pb-foot").append(backBtn, confirmBtn);
                logLine(`Ready to delete ${n} message(s). This cannot be undone.`);
                const done = val => { cancelConfirm = null; confirmBtn.remove(); backBtn.remove(); startBtn.style.display = ""; resolve(val); };
                cancelConfirm = () => done(false);
                // Confirm is the deliberate "go". Clear any Stop that landed during the
                // scan/confirm phase (e.g. from the minimized pill) so deletion isn't wedged.
                confirmBtn.onclick = () => { aborted = false; stopBtn.style.display = ""; done(true); };
                backBtn.onclick = () => done(false);
            });
        }

        startBtn.onclick = run;
        stopBtn.onclick = () => { stopPurge(); logLine("Stopping"); };

        document.body.appendChild(overlay);
        modalEl = overlay;
        activeModal = { expand, running: () => running };
    }

    const TRASH_PATH = "M14.25 1c.41 0 .75.34.75.75V3h5.25c.41 0 .75.34.75.75v.5c0 .41-.34.75-.75.75H3.75A.75.75 0 0 1 3 4.25v-.5c0-.41.34-.75.75-.75H9V1.75c0-.41.34-.75.75-.75h4.5Z M5.06 7a1 1 0 0 0-1 1.06l.76 12.13a3 3 0 0 0 3 2.81h8.36a3 3 0 0 0 3-2.81l.76-12.13a1 1 0 0 0-1-1.06H5.06Z";

    let tipEl = null;
    function showTip(target, text) {
        ensureStyles();
        if (!tipEl) {
            tipEl = document.createElement("div");
            tipEl.className = "pb-tip";
            tipEl.innerHTML = `<span class="pb-tip-caret"><svg width="16" height="10" viewBox="0 0 16 10" fill="none"><path d="M10.3426 7.0715C9.14163 8.57272 6.85837 8.57272 5.65739 7.0715L0 -0.000244141L16 -0.000244141L10.3426 7.0715Z"></path></svg></span><span class="pb-tip-label"></span>`;
            document.body.appendChild(tipEl);
        }
        tipEl.querySelector(".pb-tip-label").textContent = text;
        tipEl.style.display = "block";
        const r = target.getBoundingClientRect();
        const tr = tipEl.getBoundingClientRect();
        tipEl.style.left = Math.round(r.left + r.width / 2 - tr.width / 2) + "px";
        tipEl.style.top = Math.round(r.bottom + 10) + "px";
    }
    function hideTip() { if (tipEl) tipEl.style.display = "none"; }

    function injectButton() {
        const toolbar = document.querySelector('[aria-label="Channel header"] [class*="toolbar_"]') || document.querySelector('[class*="toolbar_"]');
        if (!toolbar || toolbar.querySelector(".purgebot-btn")) return;
        const template = toolbar.querySelector('[class*="iconWrapper_"]');
        const wrapClass = template ? template.className : "";
        const svgClass = template && template.querySelector("svg") ? template.querySelector("svg").getAttribute("class") : "";
        const btn = document.createElement("div");
        btn.className = (wrapClass ? wrapClass + " " : "") + "purgebot-btn";
        btn.setAttribute("role", "button");
        btn.setAttribute("aria-label", "Purge messages");
        btn.setAttribute("tabindex", "0");
        btn.innerHTML = `<svg class="${svgClass}" width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path fill="currentColor" d="${TRASH_PATH}"></path></svg>`;
        btn.addEventListener("click", () => { hideTip(); forcedChannelId = null; forcedGuildId = null; openModal(); });
        btn.addEventListener("mouseenter", () => showTip(btn, "Purge messages"));
        btn.addEventListener("mouseleave", hideTip);
        btn.addEventListener("focus", () => showTip(btn, "Purge messages"));
        btn.addEventListener("blur", hideTip);
        toolbar.insertBefore(btn, toolbar.firstChild);
    }

    // Capture which channel/DM was right-clicked so the menu item can target it.
    let ctxAt = 0;
    document.addEventListener("contextmenu", e => {
        const link = e.target.closest && e.target.closest('a[href*="/channels/"], [data-list-item-id*="channels"]');
        let id = null, guild = null;
        if (link) {
            const href = link.getAttribute("href") || link.getAttribute("data-list-item-id") || "";
            const m = href.match(/channels[\/_-](@me|\d+)[\/_-](\d+)/);
            if (m) { id = m[2]; guild = m[1] === "@me" ? null : m[1]; }
            else { const one = href.match(/(\d{15,})/); if (one) id = one[1]; }
        }
        ctxChannelId = id; ctxGuildId = guild; ctxAt = Date.now();
    }, true);

    function dismissContextMenus() {
        try { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true })); } catch (e) { }
        document.querySelectorAll('[role="menu"]').forEach(m => {
            const layer = m.closest('[data-popover-layer], [class*="layer_"]');
            try { (layer || m).remove(); } catch (e) { }
        });
    }

    function injectContextItem() {
        // Only on an actual right-click context menu (not hover action bars/popouts),
        // and only right after the right-click that captured the channel.
        if (!ctxChannelId || Date.now() - ctxAt > 2500) return;
        const menu = document.querySelector('[role="menu"][id*="context"]');
        if (!menu || menu.querySelector(".purgebot-ctx")) return;
        const items = [...menu.querySelectorAll('[role="menuitem"]')];
        const template = items.find(it => !it.querySelector("svg") && it.getAttribute("aria-disabled") !== "true") || items[0];
        if (!template) return;
        const item = template.cloneNode(true);
        item.classList.add("purgebot-ctx");
        item.removeAttribute("id");
        item.setAttribute("aria-disabled", "false");
        const span = item.querySelector("span");
        if (span) span.textContent = "Delete Messages";
        const sub = item.querySelector('[class*="subtext"]');
        if (sub) sub.remove();

        // Match Discord's highlight: it toggles a "focused_<hash>" class (not :hover),
        // and only one item is focused at a time.
        const itemCls = [...template.classList].find(c => /^item_/.test(c));
        const FOCUSED = itemCls ? "focused_" + itemCls.slice(5) : null;
        if (FOCUSED) {
            item.classList.remove(FOCUSED);
            item.addEventListener("mouseenter", () => {
                const ownMenu = item.closest('[role="menu"]') || menu;
                ownMenu.querySelectorAll("." + FOCUSED).forEach(el => el.classList.remove(FOCUSED));
                item.classList.add(FOCUSED);
                // collapse any open submenu (e.g. Mute duration), like a native item does:
                // tell Discord the expanded parent is unhovered, then drop the leftover popover.
                ownMenu.querySelectorAll('[aria-haspopup="true"][aria-expanded="true"]').forEach(el => {
                    el.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false, relatedTarget: document.body }));
                    el.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
                });
                document.querySelectorAll('[role="menu"]').forEach(m => {
                    if (m !== ownMenu && !ownMenu.contains(m) && !m.contains(ownMenu)) {
                        const layer = m.closest('[data-popover-layer], [class*="layer_"]');
                        try { (layer || m).remove(); } catch (e) { }
                    }
                });
            });
            item.addEventListener("mouseleave", () => item.classList.remove(FOCUSED));
        }

        const targetId = ctxChannelId, targetGuild = ctxGuildId;
        item.addEventListener("click", e => {
            e.preventDefault(); e.stopPropagation();
            forcedChannelId = targetId; forcedGuildId = targetGuild;
            dismissContextMenus();
            openModal();
        }, true);
        const groups = menu.querySelectorAll('[role="group"]');
        (groups[groups.length - 1] || menu).appendChild(item);
    }

    function ensureButton() { try { injectButton(); } catch (e) { } try { injectContextItem(); } catch (e) { } }
    let scheduled = false;
    function startObserving() {
        if (!document.body) return;
        new MutationObserver(() => {
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(() => { scheduled = false; ensureButton(); });
        }).observe(document.body, { childList: true, subtree: true });
        ensureButton();
    }
    if (document.body) startObserving();
    else document.addEventListener("DOMContentLoaded", startObserving);
    setInterval(ensureButton, 1000);

    if (typeof GM_registerMenuCommand === "function") GM_registerMenuCommand("Open Purge Bot", openModal);

    console.log("%c[PurgeBot] Loaded. Click the trash button in the channel header.", "color:#5865F2;font-weight:bold");
})();
