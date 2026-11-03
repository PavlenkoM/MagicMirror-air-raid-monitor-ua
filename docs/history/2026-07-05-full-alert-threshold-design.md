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
   districts-only). ~~A district-level alert that has no separate
   per-community alert entries counts as exactly one "part" alerted, same
   weight as a single alerted community.~~ **Superseded — see Addendum below:**
   a district-level alert now cascades to count all of that district's own
   communities as alerted too, instead of counting the district as a single
   flat unit. The flat *denominator* (total parts) is unchanged; only how the
   *numerator* counts a district alert changed.
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

## Addendum (2026-07-05, post-deployment): cascade district alerts to communities

**Finding:** after merging the initial version to `state-full-alert` and
checking it against live data, two frontline oblasts — Zaporizhzhya
(oblastId `12`) and Donets'k (oblastId `28`) — stayed `partial` when every
single one of their districts was under active alert, which reads as
counter-intuitive: "100% of an oblast's districts alerted" should plausibly
mean the oblast is fully covered.

Root cause, confirmed against real `/alerts` data fetched through the
isolated test instance: Zaporizhzhya has 72 total parts (5 districts + their
~66 communities + the mistyped top-level community `564`); the 6 alerted
entries were regionIds `145`–`149` (all 5 of Zaporizhzhya's districts) plus
`564` — i.e. **every district** was alerted, but *none* of the ~66
communities underneath had their own separate alert entries. Ratio: 6/72 ≈
8%, nowhere near the 50% threshold. Donets'k showed the identical pattern:
all 8 of its districts alerted (regionIds `49`–`56`), 8/74 ≈ 11%. In both
cases the real API reports alerts at district granularity only — it does not
cascade an alert down to emit a separate entry per community. The flat
"1 unit per node regardless of level" counting rule (original Decision 1)
treats a fully-alerted district as worth exactly the same as one single
alerted community out of ~15-16 siblings, which silently dilutes exactly the
scenario this feature was built to detect.

**Decision:** when a District-level entry itself has an active alert, count
*all* of that district's own communities as alerted too (not just the
district as one flat unit), instead of requiring each community to have its
own separate alert entry. The total-parts denominator from Decision 1 is
unchanged (still every District + Community node, flat) — only the
numerator's counting rule changes for entries that turn out to be Districts
with their own children.

This was chosen over two alternatives, presented with the real numbers above:
- **Districts-only counting** (drop communities from both numerator and
  denominator): simpler, and would also produce `full` for both oblasts
  today, but throws away community-level granularity entirely, including for
  any future case where the API *does* report alerts at community level
  without the parent district also being alerted.
- **Just lowering the threshold**: cheapest, no logic change, but arbitrary —
  the "right" threshold would depend on each oblast's district-to-community
  ratio (varies from ~4 districts/50 communities to ~8 districts/74
  communities across oblasts), so a single global threshold can't be tuned to
  work correctly for all of them at once.

### Implementation

`loadRegions()`'s walk needs one more piece of tree shape it currently
throws away: which regionIds are each node's *immediate* children (today it
only keeps `regionId → oblastId` and a flat total count). Add a sibling map,
`this.childrenByRegionId` (`regionId → string[]` of immediate child
regionIds, from `region.regionChildIds`), built in the same walk, reset on
the same weekly refresh. A leaf node (a Community, or a childless oblast
like Kyiv City/Crimea) simply has no entry (or an empty array).

In `getRegionStatuses()`, replace the flat `alertedPartsByOblast` counter
with a per-oblast `Set` of "covered" regionIds. For each non-self alerted
entry, add its own regionId to the oblast's covered set, **and** recursively
add every ID in `this.childrenByRegionId[entry.regionId]` (and their
children, etc. — though today's hierarchy is only ever District→Community,
one level deep) to the same set. The ratio becomes
`coveredSet.size / totalPartsByOblast[oblastId]`. A `Set` (not a running sum)
is required so that a district's alert and one of its own community's alerts
don't get double-counted if both happen to appear in the same `/alerts`
response.

Self-alert-always-wins (Decision 4), the strict `>` comparison (Decision 3),
the configurable threshold (Decision 2), and the childless-oblast handling
(Decision 5) are all unchanged by this addendum.

### Testing

Same manual-verification approach as before (isolated port-8081 instance),
plus this addendum was *discovered* by, and should be *re-verified* against,
real live `/alerts` data for Zaporizhzhya (`12`) and Donets'k (`28`) — after
the fix, both should compute `alertedParts` at or near `totalPartsByOblast`
(cascading covers nearly the whole subtree when every district is alerted)
and render `full`, not `partial`.
