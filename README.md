#  MagicMirror-air-raid-monitor-ua

This is an extension for the [MagicMirror](https://github.com/MichMich/MagicMirror). It shows the current status of air raid alerts across Ukraine's regions on a map of the country.
Based on data from the [UkraineAlarm API](https://www.ukrainealarm.com/). The module gets the data in one of two ways:

- **Directly from the API** with your own API key. Simple, but the API allows about one request per minute per key, so the map updates every 90 seconds at best and every device needs its own key.
- **From your own server** that fetches the data from the API once and serves it to any number of devices (see [Using your own server](#using-your-own-server)). The map can update every 10 seconds.

<img width="328" alt="Знімок екрана 2022-05-31 о 22 59 29" src="https://user-images.githubusercontent.com/9430298/171278252-afbf185c-b40f-4214-8292-6fa9d43af002.png">


## Installation
1. Install and configure [MagicMirror](https://docs.magicmirror.builders).
2. Navigate into your MagicMirror's `modules` folder and execute `git clone https://github.com/PavlenkoM/MagicMirror-air-raid-monitor-ua.git`
3. To use this module, add it to the modules array in the `config/config.js` file.

With an API key:
````javascript
modules: [
	{
		module: 'MagicMirror-air-raid-monitor-ua',
		config: {
			apiKey: 'YOUR_API_KEY',
			updateInterval: 90,
			fullAlertThreshold: 0.5,
		}
	}
]
````

With your own server (no API key needed on the device):
````javascript
modules: [
	{
		module: 'MagicMirror-air-raid-monitor-ua',
		config: {
			relayUrl: 'https://your-server.example/v1',
			relayToken: 'YOUR_DEVICE_TOKEN',
			updateInterval: 10,
			fullAlertThreshold: 0.5,
		}
	}
]
````

## Configuration options
The following properties can be configured:

| Option | Description |
| --- | --- |
| `apiKey` | Your API key for accessing the air raid data. Not needed when `relayUrl` is set. |
| `relayUrl` | Optional. Base URL of your own server that serves `/alerts` and `/regions` in the UkraineAlarm API format (e.g. `https://example.com/v1`). When set, the module reads data from it instead of the API. |
| `relayToken` | Read token for `relayUrl`, sent in the `X-Relay-Token` header. |
| `updateInterval` | Interval of updating information about air raids in Ukraine. Value in seconds. With `apiKey`, the default and minimum is 90 seconds (lower values are ignored) — the UkraineAlarm API rate-limits each key to about one request per minute and rejects faster polling, so the module keeps a safety margin above that limit. With `relayUrl`, the default and minimum is 10 seconds. |
| `fullAlertThreshold` | Fraction (0–1) of an oblast's districts/communities that must be under alert before the whole oblast is painted "full" instead of "partial". Strict greater-than (exactly at the threshold stays "partial"). Default `0.5`. |
| `staleAfter` | Minutes. When the shown data is older than this — updates keep failing, or your server has not synced with the API — the map is dimmed and a notice below it says how old the data is ("Data is out of date: as of 21:00"). `0` turns this off. Default `10`. |

## Using your own server
Any server works as long as it follows this contract. The module appends the endpoint paths to `relayUrl` (trailing slashes are ignored; `relayUrl` must not contain `?` or `#`):

| Request | Response |
| --- | --- |
| `GET {relayUrl}/alerts` | The same JSON as UkraineAlarm `GET /api/v3/alerts`. |
| `GET {relayUrl}/regions` | The same JSON as UkraineAlarm `GET /api/v3/regions`. |

- **Authorization:** the module sends `relayToken` in the `X-Relay-Token` header. Answer `401` to a missing or wrong token.
- **Caching (optional, recommended):** if the response has an `ETag` header, the next request carries it in `If-None-Match`. Answer `304 Not Modified` with an empty body when the data has not changed, so frequent polling costs only a few hundred bytes.
- **Freshness (optional, recommended):** send `X-Relay-Synced-At` (ISO 8601, e.g. `2026-10-28T21:00:00Z`) with `/alerts` responses, including `304`, set to when the server last confirmed its data against the API. The module uses it for `staleAfter`. Without it, the data counts as current whenever the server answers.
- **Errors:** any other non-2xx status, an unreachable server, or no answer within 8 seconds counts as a failed update. The map keeps showing the last data and the module retries on the next cycle.
- **Regions:** the module caches the `/regions` response on disk for 7 days, so the server is asked for it rarely.

When `relayUrl` is set, the module uses the server even if `apiKey` is also present, and never sends the API key anywhere.

## License
This module is licensed under the [MIT License](LICENSE.md).
