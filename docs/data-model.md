# Data model

What the module reads, what passes between its two halves, and what it keeps. The contract a server must follow is in the [README](../README.md#using-your-own-server); the full response formats are UkraineAlarm's ([Swagger](https://api.ukrainealarm.com/swagger/index.html)). Times are ISO 8601 strings in UTC.

## Upstream responses — the fields the module uses

Both sources return the same JSON as the UkraineAlarm API v3. The module ignores every field not listed here, so extra or unknown fields are harmless.

### `GET /alerts` → `AlertRegionModel[]`

| Field | Type | Used for |
|---|---|---|
| `[].regionId` | string | mapping the entry to its oblast |
| `[].activeAlerts` | array (may be empty or `null`) | only its length: non-empty = the region has an alert |

Alert types, levels (`Red` / `Yellow`) and reasons are **not** used: any active alert counts. The whole array is also compared as JSON with the previous one to decide whether to re-render.

### `GET /regions` → `RegionsViewModel`

```json
{ "states": [ { "regionId": "14", "regionName": "Київська область", "regionType": "State",
                "regionChildIds": [ { "regionId": "75", "regionChildIds": [ … ] } ] } ] }
```

| Field | Type | Used for |
|---|---|---|
| `states[]` | array | top-level regions: oblasts, plus city communities `564` and `1293` folded into their oblasts |
| `…regionId` | string | the lookups below |
| `…regionChildIds[]` | array of region objects (despite the name), recursive, may be missing | walking the tree |

### Response headers

| Header | Source | Used for |
|---|---|---|
| `ETag` | relay | sent back as `If-None-Match` |
| `X-Relay-Synced-At` | relay (optional) | freshness → `X-Data-As-Of`; must parse as a date, else ignored |

## Between the front end and the node_helper

Routes on MagicMirror's own server (same origin as the mirror page):

| Route | Request headers | Success | Error |
|---|---|---|---|
| `GET /alerts` | direct: `Authorization`; relay: `X-Relay-Url`, `X-Relay-Token` | `200`, upstream JSON as is, header `X-Data-As-Of` | `500 {"error": "<message>"}` for any upstream error status, network failure or timeout (the message names the status, with a hint for `401`); `400` for an invalid `relayUrl`, without any request |
| `GET /regions` | the same | `200`, upstream JSON (or the disk cache) | as above; with a cache, network and upstream errors return the stale copy instead |

`X-Data-As-Of` — ISO time: `X-Relay-Synced-At` of the last `200`/`304` from the relay, else the time of this fetch.

The front end treats any non-2xx as a failed update and keeps the last data. The map SVG is served by MagicMirror from `public/` at `/MagicMirror-air-raid-monitor-ua/ua.svg`.

## Lookups built from `/regions`

| Lookup | Shape | Meaning |
|---|---|---|
| `regionToOblast` | `{ regionId: oblastId }` | every region (oblast itself included) → its oblast |
| `totalPartsByOblast` | `{ oblastId: number }` | how many descendants (all levels, the oblast excluded) the oblast has — the denominator for `fullAlertThreshold` |
| `childrenByRegionId` | `{ regionId: [childId, …] }` | immediate children, for cascading a district's alert to its communities |

## Constants

| Constant | Value | Meaning |
|---|---|---|
| `OBLAST_ID_TO_SVG_NAME` | `{ '14': 'Kyiv', '31': 'Kyiv City', '9999': 'Crimea', … }` (26 entries) | oblast `regionId` → `name` attribute of its shape in `public/ua.svg` |
| `TOP_LEVEL_COMMUNITY_TO_OBLAST` | `{ '564': '12', '1293': '22' }` | top-level city communities → their oblast |
| `DIRECT_MIN_UPDATE_INTERVAL`, `RELAY_MIN_UPDATE_INTERVAL` | 90, 10 | seconds |
| `REGIONS_REFRESH_INTERVAL` (front end), `REGIONS_CACHE_TTL` (node_helper) | 7 days | |
| `RELAY_TIMEOUT` | 8 s | per relay request |

## Map statuses

`getRegionStatuses()` returns `{ svgName: status }`, `status` ∈ `full` \| `partial`; oblasts missing from the result are `no_data`. CSS classes: `air-raid-status-<status>`; each status's selector list gets `[name="<svgName>"]` entries.

## Configuration

| Option | Type | Default | Notes |
|---|---|---|---|
| `apiKey` | string \| null | `null` | direct mode |
| `relayUrl` | string \| null | `null` | relay mode; wins over `apiKey` |
| `relayToken` | string \| null | `null` | sent as `X-Relay-Token` (empty string if unset) |
| `updateInterval` | number \| null | `null` | seconds; raised to the mode's minimum |
| `fullAlertThreshold` | number 0…1 | `0.5` | strict greater-than |
| `staleAfter` | number | `10` | minutes; `0` disables the notice |

## Disk cache

`.regions-cache.json` next to `node_helper.js` (git-ignored): the raw `/regions` JSON. Its age is the file's mtime. Delete it to force a refetch.
