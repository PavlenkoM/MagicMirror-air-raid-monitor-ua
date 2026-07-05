# Design: threshold-based "full" alert status for oblasts

## Problem

The map (`public/ua.svg`) only has 27 shapes, one per oblast. The Ukraine Alert
API's `/alerts` data is far more granular: every District and Community under
an oblast gets its own entry in the response. Today, `getRegionStatuses()` in
`MagicMirror-air-raid-monitor-ua.js` paints an oblast:

- `full` only if the oblast's *own* regionId has an active alert (a genuine
  oblast-wide siren)
- `partial` if *any* single descendant (district or community) has an active
  alert, no matter how small a fraction of the oblast that is

So a single alerted community out of ~50 in an oblast looks identical on the
map to 49 out of 50 alerted communities — both just show `partial`. This
under-represents oblasts that are almost entirely under alert.

## Goal

When more than a configurable fraction of an oblast's sub-regions currently
have an active alert, paint the whole oblast `full` instead of `partial`.

## Decisions

1. **What counts as a "part":** every District and Community node under the
   oblast, counted flatly in one denominator (not leaf-communities-only, not
   districts-only). A district-level alert that has no separate per-community
   alert entries counts as exactly one "part" alerted, same weight as a single
   alerted community. This was chosen over leaf-only counting because it
   requires no extra logic to translate a district-level alert into "all its
   communities," and over district-only counting because it would make the
   threshold trigger on far coarser events.
2. **Threshold is user-configurable**, not hardcoded, via
   `config.fullAlertThreshold` (default `0.5`), consistent with how
   `updateInterval` is already exposed in `defaults`.
3. **Comparison is strict `>`**, not `>=`: "more than 50%" per the original
   ask. Exactly at the threshold stays `partial`.
4. **Self-alert always wins**: if the oblast's own regionId has an active
   alert, it is `full` regardless of the ratio calculation (unchanged from
   today).
5. **Childless oblasts** (Kyiv City `31`, Crimea `9999`, both with zero
   `regionChildIds`) are unaffected: they have no descendant "parts" to ratio
   against, so they can only ever be unstyled (no alert, default map color)
   or `full` via self-alert, exactly as today. (`no_data` is a distinct
   legend entry that `getRegionStatuses()` never actually assigns to a
   region today; this design doesn't change that.)

## Implementation

### 1. Config default

Add to `defaults` in `MagicMirror-air-raid-monitor-ua.js`:

```js
defaults: {
    updateInterval: 60 * 1.5,
    fullAlertThreshold: 0.5,
},
```

### 2. Precompute part-totals in `loadRegions()`

`loadRegions()` already does a single recursive walk over the `/regions`
response to build `regionToOblast` (regionId → oblastId), refreshed at most
weekly. Extend the same `walk` closure to also tally a sibling map,
`totalPartsByOblast` (oblastId → count of descendant parts), incrementing
once for every node visited where `region.regionId !== oblastId` — i.e.
every node except the oblast's own self-entry. This correctly includes the
two mistyped top-level communities (`564`, `1293`) as parts of their real
oblast (`12`, `22`), since for those nodes `region.regionId` (`564`/`1293`)
never equals the `oblastId` (`12`/`22`) passed down to them.

Store as `this.totalPartsByOblast`, reset together with `regionToOblast` on
the existing weekly refresh (`regionsLoadedAt` check).

### 3. Rework `getRegionStatuses()`

Replace the current "first child alert wins partial, self-alert wins full"
loop with a two-pass approach:

1. Walk `airRaidData`. For each entry with a non-empty `activeAlerts`,
   resolve `oblastId = this.regionToOblast[entry.regionId]`. If
   `entry.regionId === oblastId`, record the oblast as self-alerted (→ will
   be `full`). Otherwise increment a per-oblast `alertedParts` counter.
2. For every oblast that had *any* alert activity (self or descendant):
   - If self-alerted → `full` (unconditional).
   - Else compute `ratio = alertedParts / (this.totalPartsByOblast[oblastId] || 0)`.
     If `ratio > this.config.fullAlertThreshold` → `full`, else → `partial`.
   - Look up the oblast's SVG name via `OBLAST_ID_TO_SVG_NAME` as today; skip
     if unmapped.

No changes to `OBLAST_ID_TO_SVG_NAME`, `TOP_LEVEL_COMMUNITY_TO_OBLAST`,
`getMapStyles()`, `getMapLegend()`, or `node_helper.js` — this is purely a
frontend derivation change over data already being fetched.

## Testing

This logic lives inside a `Module.register(...)` object with no existing
unit test harness. Verification will be manual, using the isolated
port-8081 MagicMirror test instance (see the `magicmirror-test-instance-recipe`
project memory): inject synthetic `airRaidData` via the browser console to
simulate an oblast crossing the >50%-parts-alerted threshold and one staying
under it, and confirm the SVG paints `full` vs `partial` accordingly. Live
alert data cannot be relied on to reproduce a >50% scenario on demand.

## Out of scope

- Any change to how `full`/`partial`/`no_data` are visually styled.
- Any change to the `/regions` or `/alerts` fetch/cache behavior in
  `node_helper.js`.
- Making the "what counts as a part" rule itself configurable — only the
  threshold fraction is.
