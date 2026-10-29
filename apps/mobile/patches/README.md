# FlashList 2.3.3 initial-index layout patch

`@shopify__flash-list@2.3.3.patch` carries the one-line range correction proposed
by theRizwan in [Shopify/flash-list PR #2444](https://github.com/Shopify/flash-list/pull/2444),
for [issue #2307](https://github.com/Shopify/flash-list/issues/2307). The PR was
open and absent from the pinned 2.3.3 package when checked on 2026-10-29.

After measuring a deep initial row, correcting only its preceding layouts can
leave the following layouts at older coordinates. The resulting backward step
breaks the visible-index binary search. Recompute through `getDataLength() - 1`
so the corrected prefix and following rows remain in the same coordinate space.

The patch changes only this call in the published `dist` manager and its matching
`src` file. This package declares `main: dist/index.js` and no `react-native`,
`browser` or `exports` override, so this project's Node/Jest and default Metro
resolution use `dist`. Source is patched too for consistent source consumers.
No maps, wrapper behavior, timers, event handling or dependency versions change.

Apply through the project pnpm workspace: `pnpm --dir apps/mobile install --frozen-lockfile`.
The exact-version `patchedDependencies` entry and patch hash are tracked. Do not
edit an installed package or shared store manually. The real SDK regression
tests exercise both entries with the 1004-row trace and the upstream 600-row case.

Remove the patch only when a deliberately updated pinned upstream release
contains the correction and these regressions pass without it. JS tests do not
establish native scroll arrival, visual correctness or device performance.
