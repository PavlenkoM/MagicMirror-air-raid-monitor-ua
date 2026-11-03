# Development

No build step and no dependencies: MagicMirror provides `Module`, `Log`, `node_helper` and `logger` at runtime, and the module uses only Node's built-in `fetch`, `fs` and `path`. Tested with Node 22.

## Tests

```sh
node --test test/*.test.js
```

Plain `node:test` + `node:assert`, no MagicMirror runtime needed:

- `test-support/load-air-raid-module.js` stubs the global `Module.register` and `Log`, requires the real front-end file and returns its definition object, so tests call its methods directly.
- `test-support/load-node-helper.js` stubs the `node_helper` and `logger` modules and returns the node_helper definition; tests replace `fetch` and point `regionsCacheFile` at a temp file.

| File | Covers |
|---|---|
| `get-region-statuses.test.js` | map colouring: oblast self-alert, threshold, cascading districts, top-level communities |
| `load-air-raid-data.test.js` | update cycle: one request per cycle, loader on first load, re-render rules, keeping the last data on errors |
| `load-regions.test.js` | building the lookups from the `/regions` tree |
| `node-helper.test.js` | both modes, relay ETag/304, trailing slashes, `relayUrl` validation, errors → `500`, disk cache of `/regions`, `X-Data-As-Of` |
| `relay-mode.test.js` | front end in relay mode: headers, intervals |
| `stale-data.test.js` | `staleAfter`, `X-Data-As-Of`, notice text and date formatting |

New behaviour comes with a test. Keep direct mode byte-for-byte as it is unless the change is meant for it.

## Trying it on a mirror

Clone into `MagicMirror/modules/`, add it to `config/config.js` (see the [README](../README.md#installation)) and restart MagicMirror. The node_helper logs (`Log.error`) go to the MagicMirror server console; the front end logs to the browser console (`Air raid alerts: N region(s) with active alerts`). To test the out-of-date notice, set `staleAfter: 1` and a wrong `relayToken` — the map dims with "No data received" after about a minute.

## Common changes

- **A region's shape is not coloured.** Check that its `regionId` is in `OBLAST_ID_TO_SVG_NAME` and that the value matches the shape's `name` attribute in `public/ua.svg`. A new top-level city community typed `State` goes into `TOP_LEVEL_COMMUNITY_TO_OBLAST`.
- **New option.** Add it to `defaults` (with a comment), to the README options table, and to [Data model](data-model.md#configuration).
- **New UI string.** Add the key to both `translations/en.json` and `uk.json`.
- **Server contract.** The module relies only on what the README section "Using your own server" says. Changing what the module expects from a server means changing that section, and keeping old servers working.

## Releases

Work happens on feature branches merged into `main` through pull requests. A release is a tag on `main` (`v1.0.0` — both data sources, `staleAfter`). Users update with `git pull` in the module folder and a MagicMirror restart.
