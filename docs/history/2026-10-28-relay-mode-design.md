# Design: relay mode ("your own server")

## Problem

The UkraineAlarm API lets each key make roughly one request per minute
(faster requests are rejected), so the module polls it every 90 s at best,
and every device needs its own key or they lock each other out.

## Goal

Keep the direct mode exactly as it is, and add a second data source: a server
the user runs themselves, which talks to the API once and serves the current
state to any number of devices as often as they like. The module does not
depend on any particular server implementation; it only relies on the
contract below.

## Configuration

| Option | Meaning |
| --- | --- |
| `apiKey` | Direct mode: the UkraineAlarm API key. |
| `relayUrl` | Relay mode: base URL of the server, e.g. `https://example.com/v1`. Trailing slashes are ignored; `?` and `#` are rejected (the token has its own option). |
| `relayToken` | Relay mode: the read token for this device. |
| `updateInterval` | Seconds. Default `null` = the minimum of the active mode: 90 s direct, 10 s relay. Lower values are raised to that minimum. |

A set `relayUrl` selects relay mode even if `apiKey` is also set. With
neither, the module logs an error at start (and every request fails, as
before).

## Server contract

The module appends `/alerts` and `/regions` to `relayUrl`:

| Request | Expected response |
| --- | --- |
| `GET {relayUrl}/alerts` | Same JSON as `GET /api/v3/alerts` (`AlertRegionModel[]`). |
| `GET {relayUrl}/regions` | Same JSON as `GET /api/v3/regions` (`RegionsViewModel`). |

- Authorization: header `X-Relay-Token: <relayToken>`. A wrong or missing
  token should answer `401`.
- Conditional requests (optional but recommended): if the server sends an
  `ETag`, the module repeats it in `If-None-Match`; a `304 Not Modified`
  with an empty body means "the data you have is current". Without an
  `ETag` every poll is a plain `GET`.
- Any other non-2xx status, an unreachable server, or no answer within 8 s
  is an error: the module keeps showing the last data and retries on the
  next cycle.

## Implementation

- **Front end** (`MagicMirror-air-raid-monitor-ua.js`) still calls the
  node_helper routes `/alerts` and `/regions`; only the headers differ:
  `Authorization: <apiKey>` in direct mode, `X-Relay-Url` + `X-Relay-Token`
  in relay mode. The API key is never sent in relay mode.
- **node_helper** picks the source per request from those headers, so
  several module instances with different sources work side by side.
  - Direct: unchanged (same URLs, same headers, no conditional requests).
  - Relay: validates `relayUrl` (http/https, no query or fragment; invalid
    → `400` with a message, no request is made), sends `X-Relay-Token`,
    keeps `{ etag, data }` per endpoint URL in memory and returns the cached
    data on `304`. Requests time out after 8 s so they cannot pile up behind
    a 10 s cycle.
  - The on-disk regions cache (7-day TTL, stale copy served on refetch
    failure) works the same in both modes; the hierarchy is identical
    whichever source produced it. A malformed `relayUrl` is reported even
    when a stale cache exists, so a typo does not go unnoticed.
- Taking `relayUrl` from a request header makes the node_helper fetch a
  caller-chosen URL. That adds nothing beyond what MagicMirror's own
  `/cors?url=` route already allows, and the routes are behind
  MagicMirror's `ipWhitelist` (localhost by default).

## Out of scope (later stages)

- README section comparing both modes and describing the contract for users.

## Stale data indicator (added 2026-10-29)

- Contract addition (optional): the server sends `X-Relay-Synced-At` (ISO 8601)
  with `/alerts`, on `200` and `304`, = when it last confirmed the data against
  the API. Missing or unparsable → the fetch time is used.
- **node_helper** answers its `/alerts` route with `X-Data-As-Of`: the relay's
  `X-Relay-Synced-At` (a `304` without the header keeps the last known value),
  or the fetch time in direct mode. The body is unchanged.
- **Front end**: option `staleAfter` (minutes, default 10, `0` = off). The time
  of the last successful `/alerts` is taken from `X-Data-As-Of`; a failed update
  keeps it, so the data ages. Strictly older than `staleAfter` → the wrapper gets
  `is-stale` (map and legend at 40 % opacity) and a notice `stale` ("Data is out
  of date: as of {time}", `HH:MM`, or `DD.MM HH:MM` for an earlier day). Before
  any data arrives, age counts from the module start and the notice is
  `stale_no_data`. The DOM is re-rendered when the notice text changes, even
  without new alert data.
- 10 minutes versus the reference relay's normal `X-Relay-Synced-At` age of up
  to ~3 minutes (full sync every 2 minutes): a few API failures in a row do not
  trigger it, a long API outage or a dead relay does.

