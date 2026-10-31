import type { FlashListProps } from '@shopify/flash-list';
import { RecyclerViewManager as PublishedManager } from '@shopify/flash-list/dist/recyclerview/RecyclerViewManager';
// Execute the real source entry in Jest without compiling the SDK's development
// sources under the app's stricter tsconfig; published types remain authoritative.
const SourceManager = require('@shopify/flash-list/src/recyclerview/RecyclerViewManager')
  .RecyclerViewManager as typeof PublishedManager;

type Item = { id: string; role: string };
type Manager = Pick<PublishedManager<Item>, 'updateLayoutParams' | 'modifyChildrenLayout' |
  'getAbsoluteLastScrollOffset' | 'getInitialScrollIndex' | 'getLayout' | 'getDataKey' | 'computeVisibleIndices' | 'dispose'>;
const engines: { name: string; create: (props: FlashListProps<Item>) => Manager }[] = [
  { name: 'published dist entry', create: props => new PublishedManager(props) },
  { name: 'source entry', create: props => new SourceManager(props) },
];
const scenarios = [
  { name: 'short inverted tail retains explicit zero rather than defaulting to final item',
    count:2, initial:0, targetHeight:100, nextHeight:150, alternating:true,
    targetKey:'tail-zero' },
  {
    name: 'native trace: 1004 alternating rows, initial368',
    count: 1004, initial: 368, targetHeight: 925.8181818181819,
    nextHeight: 953.4545454545455, alternating: true,
    targetKey: '4954db82-27c1-4df5-933d-24f52a30de20',
  },
  {
    name: 'upstream issue2307: 600 rows at300, initial250',
    count: 600, initial: 250, targetHeight: 300, nextHeight: 300,
    alternating: false, targetKey: 'synthetic-target250',
  },
];

// Actual pinned SDK classes, with no recycler/layout mocks or supplied row.y.
// These are JS layout invariants, not native arrival or performance evidence.
function afterInitialMeasurements(
  create: (props: FlashListProps<Item>) => Manager,
  scenario: typeof scenarios[number],
) {
  const data = Array.from({ length: scenario.count }, (_, index) => ({
    id: index === scenario.initial ? scenario.targetKey : `synthetic-${index}`,
    role: scenario.alternating ? (index % 2 === 0 ? 'assistant' : 'user') : 'row',
  }));
  const manager = create({ data, renderItem: () => null, keyExtractor: item => item.id,
    getItemType: item => item.role, inverted: true, initialScrollIndex: scenario.initial,
    maintainVisibleContentPosition: { disabled:false,startRenderingFromBottom:true } });
  expect(manager.getInitialScrollIndex()).toBe(scenario.initial);
  manager.updateLayoutParams({ width: 320, height: 280 }, 24);
  manager.modifyChildrenLayout([], scenario.count);
  // The cold manager starts with its real internal200 estimate, not caller estimates.
  expect(manager.getAbsoluteLastScrollOffset()).toBe(scenario.initial * 200 + 24);
  manager.modifyChildrenLayout([
    { index: scenario.initial, dimensions: { width: 320, height: scenario.targetHeight } },
    { index: scenario.initial + 1, dimensions: { width: 320, height: scenario.nextHeight } },
  ], scenario.count);
  return manager;
}

describe.each(engines)('$name', engine => {
  describe.each(scenarios)('$name', scenario => {
    test('keeps the measured target and successor in increasing layout order', () => {
      const manager = afterInitialMeasurements(engine.create, scenario);
      try {
        // getLayout may re-estimate unmeasured rows. Read only the two rows that
        // were measured above, then copy their scalar fields immediately.
        const target = { ...manager.getLayout(scenario.initial) };
        const next = { ...manager.getLayout(scenario.initial + 1) };
        expect(target.isHeightMeasured).toBe(true);
        expect(next.isHeightMeasured).toBe(true);
        expect(manager.getDataKey(scenario.initial)).toBe(scenario.targetKey);
        expect(next.y).toBeGreaterThanOrEqual(target.y + target.height);
      } finally { manager.dispose(); }
    });

    test('resolves the requested stable key as visible after initial adjustment', () => {
      const manager = afterInitialMeasurements(engine.create, scenario);
      try {
        const visible = manager.computeVisibleIndices();
        expect(manager.getDataKey(scenario.initial)).toBe(scenario.targetKey);
        expect(visible.startIndex).toBeLessThanOrEqual(scenario.initial);
        expect(visible.endIndex).toBeGreaterThanOrEqual(scenario.initial);
      } finally { manager.dispose(); }
    });
  });
});
