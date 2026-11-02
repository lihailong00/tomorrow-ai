import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppProvider, type AppContextValue } from '../src/app/context';
import { TasksScreen } from '../src/screens/Main';
jest.mock('../src/ui/visuals', () => ({
  Icon: () => null,
  AssistantOrb: () => null,
}));
beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
test.each(['tasks', 'schedules'] as const)(
  'the sidebar enters the existing %s screen with the requested list selected',
  async initialView => {
    const navigate = jest.fn();
    const api = {
      tasks: jest.fn().mockResolvedValue({ items: [] }),
      schedules: jest.fn().mockResolvedValue({ items: [] }),
    };
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(
        <AppProvider
          value={
            {
              api,
              navigate,
              revision: 0,
              formatDate: () => '',
            } as unknown as AppContextValue
          }
        >
          <TasksScreen initialView={initialView} />
        </AppProvider>,
      );
    });
    try {
      const action = initialView === 'schedules' ? '新建计划' : '新建任务';
      const button = tree.root.findAll(
        node =>
          node.props.accessibilityLabel === action &&
          typeof node.props.onPress === 'function',
      )[0];
      expect(button).toBeDefined();
      await act(async () => button.props.onPress());
      expect(navigate).toHaveBeenCalledWith({
        name: initialView === 'schedules' ? 'schedule' : 'newTask',
      });
      expect(api.schedules).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => tree.unmount());
    }
  },
);
