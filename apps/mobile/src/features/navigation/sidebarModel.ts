import type { MainTab, Route } from '../../app/context';
import type { IconName } from '../../ui/visuals';

export type SidebarDestination =
  | { kind: 'tab'; tab: MainTab }
  | { kind: 'route'; route: Route };
export type SidebarItem = {
  id: string;
  label: string;
  icon: IconName;
  keywords: string;
  destination: SidebarDestination;
};

export const sidebarGroups: { title: string; items: SidebarItem[] }[] = [
  {
    title: '日常',
    items: [
      {
        id: 'today',
        label: '今日',
        icon: 'today',
        keywords: '首页 今天 简报',
        destination: { kind: 'tab', tab: 'today' },
      },
      {
        id: 'tasks',
        label: '我的任务',
        icon: 'tasks',
        keywords: '待办 事项 todo',
        destination: { kind: 'tab', tab: 'tasks' },
      },
      {
        id: 'growth',
        label: '每日成长',
        icon: 'growth',
        keywords: '成就 习惯 小目标',
        destination: { kind: 'route', route: { name: 'growth' } },
      },
    ],
  },
  {
    title: '我的内容',
    items: [
      {
        id: 'conversations',
        label: '对话记录',
        icon: 'history',
        keywords: '历史 会话 聊天',
        destination: { kind: 'route', route: { name: 'conversations' } },
      },
      {
        id: 'memories',
        label: '记忆',
        icon: 'memory',
        keywords: '偏好 记住 了解我',
        destination: { kind: 'tab', tab: 'memories' },
      },
      {
        id: 'artifacts',
        label: '我的成果',
        icon: 'file',
        keywords: '草稿 文稿 总结 结果',
        destination: { kind: 'route', route: { name: 'artifacts' } },
      },
      {
        id: 'uploads',
        label: '文件与导入',
        icon: 'folder',
        keywords: '附件 录音 上传 资料 文件',
        destination: { kind: 'route', route: { name: 'uploads' } },
      },
    ],
  },
  {
    title: '服务与工具',
    items: [
      {
        id: 'usage',
        label: '用量与费用',
        icon: 'file',
        keywords: '消费 费用 用量 账单 模型 Token 计费',
        destination: { kind: 'route', route: { name: 'usage' } },
      },
      {
        id: 'integrations',
        label: '应用连接',
        icon: 'connections',
        keywords: '邮箱 邮件 QQ 网易 飞书 钉钉 微信 日历 短信 联系人 手机 授权',
        destination: { kind: 'route', route: { name: 'integrations' } },
      },
      {
        id: 'health',
        label: '健康数据',
        icon: 'health',
        keywords: '运动 睡眠 步数 华为 小米 设备',
        destination: { kind: 'route', route: { name: 'health' } },
      },
    ],
  },
];
export const sidebarTools: SidebarItem[] = [
  {
    id: 'schedules',
    label: '定时安排',
    icon: 'calendar',
    keywords: '计划 定时 提醒 日程',
    destination: {
      kind: 'route',
      route: { name: 'assistantTasks', view: 'schedules' },
    },
  },
  {
    id: 'assistantTasks',
    label: 'AI 执行任务',
    icon: 'sparkles',
    keywords: '执行 运行 进度 助手',
    destination: {
      kind: 'route',
      route: { name: 'assistantTasks', view: 'tasks' },
    },
  },
  {
    id: 'aiHistory',
    label: '导入 AI 对话',
    icon: 'import',
    keywords: 'ChatGPT Claude DeepSeek 豆包 迁移',
    destination: { kind: 'route', route: { name: 'aiHistory' } },
  },
];
export const sidebarUtilities: SidebarItem[] = [
  {
    id: 'settings',
    label: '设置',
    icon: 'settings',
    keywords: '通知 权限 数据 隐私',
    destination: { kind: 'route', route: { name: 'settings' } },
  },
  {
    id: 'help',
    label: '帮助与反馈',
    icon: 'help',
    keywords: '指南 教程 问题 反馈',
    destination: { kind: 'route', route: { name: 'help' } },
  },
  {
    id: 'server',
    label: '服务连接',
    icon: 'server',
    keywords: '官方 自建 后端 服务器 地址',
    destination: {
      kind: 'route',
      route: { name: 'settings', section: 'server' },
    },
  },
  {
    id: 'notifications',
    label: '消息通知',
    icon: 'bell',
    keywords: '动态 未读 提醒',
    destination: { kind: 'route', route: { name: 'notifications' } },
  },
];
export function searchSidebar(query: string): SidebarItem[] {
  const term = query.normalize('NFKC').trim().toLowerCase();
  if (!term) return [];
  return [
    ...sidebarGroups.flatMap(group => group.items),
    ...sidebarTools,
    ...sidebarUtilities,
  ].filter(item =>
    (item.label + ' ' + item.keywords)
      .normalize('NFKC')
      .toLowerCase()
      .includes(term),
  );
}
export function sidebarActiveId(route: Route, tab: MainTab): string {
  if (route.name === 'main')
    return (route.tab ?? tab) === 'capabilities'
      ? 'integrations'
      : route.tab ?? tab;
  if (
    route.name === 'todos' ||
    route.name === 'todo' ||
    route.name === 'todoSources'
  )
    return 'tasks';
  if (route.name === 'memory') return 'memories';
  if (route.name === 'growthWeek' || route.name === 'growthSettings')
    return 'growth';
  if (route.name === 'assistantTasks')
    return route.view === 'schedules' ? 'schedules' : 'assistantTasks';
  if (route.name === 'schedule') return 'schedules';
  if (route.name === 'settings' && route.section === 'server') return 'server';
  return route.name;
}
