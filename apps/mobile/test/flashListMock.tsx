import React from 'react';
import { View } from 'react-native';
import type { FlashListProps } from '@shopify/flash-list';

/** Adapter unit double. Measurements and native packets are supplied separately
 * by each test. A scroll command deliberately emits no arrival notification.
 * This does not model recycling, layout projection, native MVCP or performance.
 */
export class FlashList<T> extends React.Component<FlashListProps<T>> {
  layouts = new Map<number, { x: number; y: number; width: number; height: number;
    isHeightMeasured?: boolean; isWidthMeasured?: boolean }>();
  visible = { startIndex: 0, endIndex: -1 };
  firstItemOffset = 24;
  nativeOffset = 0;
  scrollToOffset = jest.fn();
  scrollToIndex = jest.fn().mockResolvedValue(undefined);
  clearLayoutCacheOnUpdate = jest.fn(() => this.layouts.clear());
  getLayout = (index: number) => this.layouts.get(index) ?? (this.props.data?.[index]
    ? { x: 0, y: index * 100, width: 360, height: 100, isHeightMeasured: false }
    : undefined);
  getFirstItemOffset = () => this.firstItemOffset;
  getAbsoluteLastScrollOffset = () => this.nativeOffset;
  getFirstVisibleIndex = () => this.visible.startIndex;
  computeVisibleIndices = () => this.visible;
  render() {
    const { data, renderItem, keyExtractor, ListHeaderComponent: Header,
      ListFooterComponent: Footer, extraData } = this.props;
    const component = (value: typeof Header) => typeof value === 'function'
      ? React.createElement(value) : value;
    return <View>
      {component(Header)}
      {data?.map((item, index) => <React.Fragment key={keyExtractor?.(item, index) ?? index}>
        {renderItem?.({ item, index, target: 'Cell', extraData })}
      </React.Fragment>)}
      {component(Footer)}
    </View>;
  }
}
