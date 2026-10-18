# dsh-tmp-cleaner

**[中文](README.md) | [English](README.en.md)**

A DSH plugin that keeps the `/tmp` cleanup daemon alive and adds a **Temp cleanup** settings page.

- Ensures `tmp-clean watch` is running at startup; if Android kills it, an in-process watchdog **revives it within ~2 minutes** — and if the daemon keeps dying, the dsh process itself runs the due cleanup as a fallback;
- The settings page shows status, edits the config, and triggers clean / dry-run through `/tmp-clean/api/*`;
- The cleaner itself is a zero-dependency Python 3 script; the CLI and the settings page **share one config file**.

## Repository layout

| Path | Purpose |
|---|---|
| `lib/index.js` | Host half: watchdog and `/tmp-clean/api/*` routes |
| `lib/client.js` | Browser half: the "临时清理" section under `settings.section` |
| `bin/tmp-clean` | The cleaner (Python 3, no third-party deps) |
| `cordis.patch.yml` | Plugin row declaration (`dsh.bundle`) |
| `test/*.mjs` | Offline tests (fake ctx / fake loader) |

The tool is called from `/root/dsh-bin/tmp-clean` (the `TOOL` constant in `lib/index.js`);
if you install it elsewhere, change that constant or copy/link `bin/tmp-clean` there.

## Host half (lib/index.js)

1. `apply()` on web startup (or plugin reload):
   - if the PID in `watch.pid` **really is tmp-clean** (checked via `/proc/<pid>/cmdline`, so PID reuse cannot fool it) → leave it alone; otherwise spawn `tmp-clean watch` detached;
   - failures only go to stderr; web startup is never blocked.
2. **In-process watchdog** (every 2 minutes):
   - Android's phantom process killer periodically kills detached children. Previously a web restart was the only way back, which is why the page could show "守护进程：未运行" forever. Now it revives within ~2 minutes;
   - respawns are throttled to once per 5 minutes;
   - if the daemon stays absent for ≥3 minutes and the interval is due, the **dsh process itself** runs `tmp-clean run` as a fallback, so cleanup does not stall.
3. Routes (via `ctx.inject(['webServer'], …)`):
   - `GET  /tmp-clean/api/status` → `tmp-clean status --json --fast` + log tail (no disk scan; page opens instantly)
   - `GET  /tmp-clean/api/status?scan=1` → full `/tmp` size scan (7–20 s, manual only)
   - `POST /tmp-clean/api/revive` → pull the watchdog up manually (throttled)
   - `POST /tmp-clean/api/config` → `tmp-clean config set …`
   - `POST /tmp-clean/api/run` → `tmp-clean run [--dry-run]`

## Browser half (lib/client.js)

A hand-written `window.__ModuleLoader__.load({ id, factory })` bundle registered into the
`settings.section` slot (id `tmp-cleaner`, order 60, label "临时清理"):

- status uses the fast path by default; the "扫描大小" button triggers the full scan;
- failures show the reason plus a **Retry** button (common right after a web restart — no page reload needed);
- when the daemon is down the page says the watchdog will bring it back, instead of a bare "未运行".

## Configuration

`/root/.tmp-clean/config.json` (shared by the CLI and the settings page):

| Field | Default | Meaning |
|---|---|---|
| `enabled` | true | enable automatic cleanup |
| `interval_hours` | 24 | cleanup interval (hours) |
| `max_size_gb` | 20 | clean when usage exceeds this |
| `target_size_gb` | 10 | clean down to this |
| `min_age_hours` | 2 | only delete directories older than this |
| `poll_minutes` | 15 | daemon poll interval |
| `dry_run` | false | dry-run mode (delete nothing) |

## Tests

```bash
node test/host-test.mjs     # fake ctx: 4 routes + fast/slow status + revive + CLI round-trip
node test/client-test.mjs   # fake loader: materialize the bundle + registration/render assertions
node test/probe-web.mjs     # probe a running web server (needs a valid local cookie)
```

## Install / uninstall

- Install: put the repo at `/root/dsh-tmp-cleaner`, add `"dsh-tmp-cleaner": "link:/root/dsh-tmp-cleaner"`
  to the profile `dependencies` and `dsh-tmp-cleaner` to `dsh.profile.bundles`, create the
  `node_modules/dsh-tmp-cleaner` link, place `bin/tmp-clean` at `/root/dsh-bin/`, then **restart the web app once**.
- Uninstall: undo the above and `kill $(cat /root/.tmp-clean/watch.pid)`.
