# Architecture

The module has two halves, as every MagicMirror module with a backend does:

- **Front end** — `MagicMirror-air-raid-monitor-ua.js`, runs in the browser of the mirror. Polls for data, turns alerts into a status per oblast and renders the SVG map with a legend.
- **node_helper** — `node_helper.js`, runs inside the MagicMirror server (Node.js). Adds two HTTP routes to MagicMirror's Express app and fetches the data upstream, so the browser never talks to the API or the server directly.

```
browser (front end)                     MagicMirror server (node_helper)              upstream
───────────────────                     ────────────────────────────────              ────────
fetch /regions  ── headers ──▶  GET /regions ─ disk cache (7 days) ─┐
fetch /alerts   ── headers ──▶  GET /alerts  ───────────────────────┼──▶ direct: https://api.ukrainealarm.com/api/v3/{alerts,regions}
     ▲                              │  X-Data-As-Of                  └──▶ relay:  {relayUrl}/{alerts,regions}  (ETag / 304)
     └────── JSON + X-Data-As-Of ◀──┘
```

## Two data sources

The front end decides the source and tells the node_helper with request headers on every call — there is no handshake over socket notifications, so several module instances with different sources can run side by side.

| | Direct (`apiKey`) | Relay (`relayUrl` + `relayToken`) |
|---|---|---|
| Headers from the front end | `Authorization: <apiKey>` | `X-Relay-Url: <relayUrl>`, `X-Relay-Token: <relayToken>` |
| Upstream | `https://api.ukrainealarm.com/api/v3/alerts`, `/regions` | `{relayUrl}/alerts`, `{relayUrl}/regions` |
| Minimum / default `updateInterval` | 90 s | 10 s |
| Conditional requests | no | `If-None-Match` with the last `ETag`; `304` reuses the cached body |
| Timeout | none (fetch default) | 8 s |
| Freshness (`X-Data-As-Of`) | time of the fetch | `X-Relay-Synced-At` from the server, else time of the fetch |

A set `relayUrl` wins over `apiKey`; the API key is then never sent anywhere. With neither set, the module logs an error at start and every request fails.

`relayUrl` is validated by the node_helper: it must be an `http(s)` URL without `?` or `#` (else `400`, even if a cached regions tree exists, so a typo does not go unnoticed). Trailing slashes are dropped before the endpoint path is appended.

The routes are on MagicMirror's own server, so they inherit its `ipWhitelist`. Accepting an arbitrary URL from a header adds no risk beyond MagicMirror's built-in `/cors?url=`.

### Why the intervals

The UkraineAlarm API allows roughly one request per minute per key and rejects faster polling (it answered `401` to a second request within seconds). Hence one API request per cycle (no `/alerts/status` pre-check) and 90 s with a safety margin. A relay serves any number of devices and answers unchanged data with a tiny `304`, so 10 s is fine.

## Update cycle (front end)

`start()` → `loadAirRaidData()` and a `setTimeout` loop every `updateInterval`:

1. `loadRegions()` — only if there is no regions tree yet or it is older than 7 days. Builds three lookups from `/regions` (see [Data model](data-model.md#lookups-built-from-regions)).
2. On the very first load only — show the loader over the map.
3. `fetchLocal('/alerts')` — one request. On success: store the alerts, `dataAsOf` = `X-Data-As-Of` (or now). On error: log it and keep showing the last data.
4. Re-render (`updateDom()`) only when something visible changed: first load, new alert data, the regions tree just arrived (the map is grey without it), or the out-of-date notice appeared, changed or went away.

## How the map is coloured

`getRegionStatuses()` turns `/alerts` into `{ svgRegionName: 'full' | 'partial' }`. Oblasts not in the result are drawn as "no data" (no alert).

1. Every entry with a non-empty `activeAlerts` is mapped to its oblast through the regions tree (`regionToOblast`).
2. An entry that **is** the oblast → the oblast is `full`, whatever its children do.
3. Otherwise the entry's region and **all its descendants** count as covered (a district's own alert covers its communities: the API reports alerts at district granularity).
4. Covered parts / all parts of the oblast (`totalPartsByOblast`) `> fullAlertThreshold` (strictly greater, default `0.5`) → `full`, otherwise `partial`.
5. The oblast `regionId` is mapped to the `name` attribute of its shape in `public/ua.svg` (`OBLAST_ID_TO_SVG_NAME`). Unknown ids are skipped.

Two city communities (Zaporizhzhia `564`, Kharkiv `1293`) sit at the top level of `/regions` typed `State` although they are not oblasts; `TOP_LEVEL_COMMUNITY_TO_OBLAST` folds them into their oblasts.

Statuses become CSS: a generated `<style>` block lists `[name="…"]` selectors per status, so the static SVG is never modified. Legend colours use the same classes (`air-raid-status-no_data`, `-partial`, `-full`).

## Out-of-date notice (`staleAfter`)

- `dataAsOf` — when the shown data was last confirmed current: the relay's `X-Relay-Synced-At` (its last full sync with the API, also refreshed by `304` responses), or the fetch time in direct mode.
- Older than `staleAfter` minutes (default 10, `0` disables) → the map and legend are dimmed (`.is-stale`) and a line below says `Data is out of date: as of 21:00` (with the date if not today, local time).
- No data at all `staleAfter` minutes after the start → `No data received`.
- Webhooks on the server do not move `X-Relay-Synced-At`; only a full sync does. With a server syncing every 2 minutes the normal age is under ~3 minutes, so a few failed updates do not trigger the notice, but an hour of server trouble does.

## Caching

| Where | What | Lifetime |
|---|---|---|
| node_helper, disk `.regions-cache.json` (git-ignored) | `/regions` response, shared by both modes (same data) | 7 days by file mtime; survives restarts. If refreshing fails with a network or upstream error, the stale copy is served |
| node_helper, memory `relayResponses` | per relay URL: last `ETag`, body, `X-Relay-Synced-At` | until restart; dropped if a `200` has no `ETag` |
| front end, memory | regions lookups; last alerts; the SVG text | regions — 7 days; the rest — page lifetime |

## Translations

`translations/en.json` and `uk.json`: legend labels (`no_data`, `partial`, `full`) and the notices (`stale` with `{time}`, `stale_no_data`). MagicMirror picks the file by its `language` setting.

## Files

| File | What |
|---|---|
| `MagicMirror-air-raid-monitor-ua.js` | front end (`Module.register`) |
| `node_helper.js` | backend routes `/alerts`, `/regions` |
| `MagicMirror-air-raid-monitor-ua.css` | layout, legend, loader, dimmed state |
| `public/ua.svg` | map of Ukraine; each oblast shape has a `name` attribute |
| `translations/*.json` | UI strings |
| `test/`, `test-support/` | tests without a MagicMirror runtime, see [Development](development.md) |
