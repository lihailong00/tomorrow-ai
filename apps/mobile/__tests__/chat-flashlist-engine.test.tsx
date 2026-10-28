import React from 'react';
import { ScrollView, Text } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { FlashList, FlashListRef } from '@shopify/flash-list';
import * as measurements from '@shopify/flash-list/dist/recyclerview/utils/measureLayout';

// This runs the installed 2.3.3 recycler, using its shipped Jest measurement
// seams. It exercises its JS render window, not native layout or scroll arrival.
test('installed engine retains a bounded nonempty inverted window across all 26 mixed-height pages and geometry changes', async () => {
  jest.useFakeTimers();
  let width = 360, scale = 1;
  const all = Array.from({ length: 1004 }, (_, index) => ({ id: `engine-${index}`,
    content: `Real row ${index}`, height: index % 10 === 0 ? 520 : 64 }));
  let data = all.slice(-40).reverse();
  (measurements.measureParentSize as jest.Mock).mockImplementation(() => ({ width, height: 640 }));
  (measurements.measureFirstChildLayout as jest.Mock).mockImplementation(() =>
    ({ x: 0, y: 24, width, height: 640 }));
  (measurements.measureItemLayout as jest.Mock).mockImplementation((view: any) => ({
    x: 0, y: 0, width, height: (data[view.props.index]?.height ?? 64) * scale,
  }));
  const ref = React.createRef<FlashListRef<(typeof all)[number]>>();
  const renderItem = ({ item }: { item: (typeof all)[number] }) =>
    <Text testID={`row-${item.id}`}>{item.content}</Text>;
  const render = () => <FlashList ref={ref} testID="engine-list" data={data}
    renderItem={renderItem} keyExtractor={item => item.id} inverted
    initialScrollIndex={0} extraData={`${width}:${scale}`}
    ListHeaderComponent={<Text>Latest spacing</Text>}
    ListFooterComponent={<Text>History control</Text>} />;
  let tree!: ReactTestRenderer;
  try {
    await act(async () => { tree = create(render()); });
    const rows = () => tree.root.findAllByType(Text).filter(node => node.props.testID?.startsWith('row-'));
    const assertWindow = () => {
      expect(rows().length).toBeGreaterThan(0);
      expect(rows().length).toBeLessThan(100);
      const visible = ref.current!.computeVisibleIndices();
      expect(visible.startIndex).toBeGreaterThanOrEqual(0);
      expect(visible.endIndex).toBeGreaterThanOrEqual(visible.startIndex);
      expect(ref.current!.getLayout(ref.current!.getFirstVisibleIndex())?.isHeightMeasured).toBe(true);
    };
    assertWindow();
    for (let page = 2; page <= 26; page++) {
      data = all.slice(-Math.min(1004, page * 40)).reverse();
      await act(async () => { tree.update(render()); await jest.advanceTimersByTimeAsync(200); });
      const y = Math.max(0, ref.current!.getChildContainerDimensions().height - 640);
      const pane = tree.root.findAllByType(ScrollView).find(node => node.props.testID === 'engine-list')!;
      await act(async () => {
        pane.props.onScroll({ nativeEvent: { contentOffset: { x: 0, y },
          contentSize: { width, height: y + 640 }, layoutMeasurement: { width, height: 640 },
          zoomScale: 1, velocity: { x: 0, y: 0 } }, timeStamp: Date.now() });
        await jest.advanceTimersByTimeAsync(200);
      });
      assertWindow();
    }
    expect(ref.current!.props.data).toHaveLength(1004);
    for (const nextScale of [2, 1]) {
      ref.current!.clearLayoutCacheOnUpdate();
      scale = nextScale; width = nextScale === 2 ? 640 : 360;
      await act(async () => { tree.update(render()); await jest.advanceTimersByTimeAsync(200); });
      assertWindow();
    }
  } finally {
    await act(async () => tree?.unmount());
    jest.useRealTimers();
  }
}, 30000);
