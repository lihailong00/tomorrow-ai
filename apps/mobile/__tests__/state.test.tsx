import React from 'react';
import { Text } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { useAction, useResource } from '../src/app/context';

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('mobile request state', () => {
  it('locks a mutation immediately, before React renders a disabled button', async () => {
    let finish!: () => void;
    let press!: () => Promise<void>;
    const operation = jest.fn(
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        }),
    );
    function Screen() {
      const action = useAction();
      press = () => action.run(operation);
      return <Text>{action.busy ? 'busy' : 'ready'}</Text>;
    }
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<Screen />);
    });
    await act(async () => {
      void press();
      void press();
    });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(tree.root.findByType(Text).props.children).toBe('busy');
    await act(async () => {
      finish();
    });
    expect(tree.root.findByType(Text).props.children).toBe('ready');
    await act(async () => tree.unmount());
  });

  it('ignores an older response after the requested record changes', async () => {
    const pending: Record<string, (value: string) => void> = {};
    const load = (id: string) =>
      new Promise<string>(resolve => {
        pending[id] = resolve;
      });
    function Screen({ id }: { id: string }) {
      const resource = useResource(() => load(id), [id]);
      return <Text>{resource.value ?? 'loading'}</Text>;
    }
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<Screen id="old-task" />);
    });
    await act(async () => {
      tree.update(<Screen id="new-task" />);
    });
    await act(async () => {
      pending['new-task']('new task result');
    });
    await act(async () => {
      pending['old-task']('outdated result');
    });
    expect(tree.root.findByType(Text).props.children).toBe('new task result');
    await act(async () => tree.unmount());
  });
});
