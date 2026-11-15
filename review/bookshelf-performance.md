# Bookshelf performance investigation

Measured locally on November 14, 2026. Resolves the redundant work reproduced for [issue #56](https://github.com/lancewilhelm/delb/issues/56). The deployment itself was not profiled.

## Findings

- Opening the unfiltered shelf loaded the complete catalog, then loaded the same pages again to build the match set. The fix derives unfiltered and collection-only matches from the authorized catalog already in memory. Additional book filters retain their server reads and stale-response protection.
- Camera changes ran the book rendering loops and rewrote spine styles. Bookcase child components keep those contents stable while the parent moves the wall. A separate compositor probe showed that promoting the wall also removes the repeated paint stalls.
- Uploaded artwork started one request per book, including distant bookcases. Browser lazy loading limits the initial requests to nearby artwork; asynchronous decoding avoids making image decode part of a synchronous render. All geometry and drop targets remain mounted.

## Repeat measurements

Both sides use production builds and the same pinned dependencies. The baseline is merge commit `1797c41`; the candidate is this PR. Each fixture ran five alternating before/after pairs in isolated headless Chrome profiles. Each run includes a new arrangement, a cold page reload, repeat view entry, a warm reload, and 90 real pointer moves. All loads rendered 800 books with successful API responses.

Values below are medians with minimum and maximum across five runs. Load timings end when the shelf geometry and book buttons have rendered, before waiting for artwork. Warm reload means the arrangement and browser assets are already available; the cold reload bypasses the browser asset cache.

| Fixture                              | Measure                | Before median (min to max) | After median (min to max) |
| ------------------------------------ | ---------------------- | -------------------------- | ------------------------- |
| No artwork, 100 ms simulated latency | Repeat view entry      | 950 ms (906 to 970)        | 486 ms (472 to 506)       |
| No artwork, 100 ms simulated latency | Warm page reload       | 1062 ms (1040 to 1072)     | 627 ms (611 to 628)       |
| No artwork, 100 ms simulated latency | Cold page reload       | 1577 ms (1564 to 1593)     | 1159 ms (1158 to 1175)    |
| No artwork, 100 ms simulated latency | Panning frame p95      | 50.1 ms (50.0 to 66.7)     | 16.7 ms (16.7 to 16.8)    |
| No artwork, 100 ms simulated latency | Initial spine requests | 0 requests (0 to 0)        | 0 requests (0 to 0)       |
| 200 artwork entries, loopback        | Repeat view entry      | 151 ms (148 to 181)        | 105 ms (89 to 118)        |
| 200 artwork entries, loopback        | Warm page reload       | 194 ms (193 to 265)        | 142 ms (132 to 158)       |
| 200 artwork entries, loopback        | Cold page reload       | 233 ms (208 to 250)        | 143 ms (138 to 172)       |
| 200 artwork entries, loopback        | Panning frame p95      | 50.1 ms (50.0 to 50.1)     | 16.7 ms (16.7 to 16.8)    |
| 200 artwork entries, loopback        | Initial spine requests | 200 requests (200 to 200)  | 36 requests (36 to 36)    |
| 800 artwork entries, loopback        | Repeat view entry      | 188 ms (166 to 221)        | 127 ms (111 to 142)       |
| 800 artwork entries, loopback        | Warm page reload       | 291 ms (285 to 302)        | 171 ms (149 to 175)       |
| 800 artwork entries, loopback        | Cold page reload       | 313 ms (296 to 345)        | 155 ms (142 to 181)       |
| 800 artwork entries, loopback        | Panning frame p95      | 50.1 ms (50.0 to 50.1)     | 16.8 ms (16.7 to 16.8)    |
| 800 artwork entries, loopback        | Initial spine requests | 800 requests (800 to 800)  | 147 requests (147 to 147) |

The 800-book unfiltered catalog changes from eight page requests to four on every run. At 100 ms of injected latency, removing four serial round trips accounts for most of the warm reload improvement. The remaining catalog pagination and application startup still take time. Panning approaches the 60 Hz frame interval in this test after separating book rendering and promoting the wall. The image-request count depends on Chrome's lazy-loading distance and the viewport.

[Per-run measurements](bookshelf-performance-results.json) contain the samples without account information. CPU profiling ran separately from the reported comparisons. The machine had 14 logical cores and a starting load average near 4; alternating the builds reduces time-related bias.

## Reproduce and verify

Use the isolated production setup and commands in the [review instructions](README.md#bookshelf-loading-and-panning). The original reproduction was:

```sh
node review/bookshelf-load-browser.mjs --runs=3 --latency=100
```

Before the fix, the repeat loading budget failed and the catalog-page assertion observed eight requests instead of four. After the fix, both assertions pass. The live `--controls` check also verifies book sizing, shelf and case resizing, keyboard order, shelf add/remove, filters, and collection dimming. Five focused tests cover catalog reuse and late filter responses.

Final validation passes 317 tests, typecheck, the production build, documentation links, the complete disposable API suite, and the fresh browser fixture. Lint passes with the existing `BookDescriptionEditor.vue` prop warning. The API suite covers bookshelf privacy, revisions, concurrency, and artwork authorization and editing.

## Evidence limits

These measurements use a synthetic library, local SQLite storage, a desktop viewport, and compressed invented WebP artwork. The 100 ms network delay is controlled test input, not a measurement of the deployment. A server query bottleneck was not established locally. The artwork comparisons measure requests and time to shelf geometry; they do not isolate decoding cost for real photographs.

A final stress check combines artwork on every book with 100 ms of simulated latency and waits for visible image decoding. The fixed build renders shelf geometry in 641 to 647 ms, while visible artwork finishes in 3261 to 3280 ms across two repeat reloads. This is a local HTTP/1.1 result. Artwork delivery on the deployed host remains unmeasured, including its HTTP protocol, bandwidth, image sizes, and request concurrency.

The catalog remains fully loaded and all books remain mounted. Additional book filters still use paginated matching reads. No database migration, arrangement format, artwork cache policy, or authorization rule changes. Physical touch devices, Docker, and the deployed host were not exercised in this investigation.
