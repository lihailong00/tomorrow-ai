import React, { useEffect } from 'react';
import { useAction, useResource } from '../../app/context';
import { appInputs, appInputSources } from '../../platform/appInputs';
import { platform } from '../../platform/ports';
import { Text } from '../../ui/Text';
import { Button, ErrorNotice } from '../../ui/components';
import type { Integration } from './types';

export function ChatAppSource({ item }: { item: Integration }) {
  return <>
    <Text>你可以从原应用分享选中的内容到妥啦。</Text>
    {item.notification_supported && appInputs.supported &&
      appInputSources.some(source => source.id === item.id) ? <NotificationSource item={item} /> : null}
  </>;
}

function NotificationSource({ item }: { item: Integration }) {
  const status = useResource(() => appInputs.getStatus(), [item.id]);
  const { refresh } = status;
  const action = useAction();
  useEffect(() => platform.onForeground?.(refresh), [refresh]);
  const connected = status.value?.notification_access && status.value.selected_apps.includes(item.id);
  return <>
    <ErrorNotice message={action.error || status.error} retry={refresh} />
    {connected ? <Text>{item.name}通知已开启。新通知会先留在手机，等你选择是否导入。</Text> : null}
    {!connected && status.value?.installed_apps.includes(item.id) ? (
      <Button loading={action.busy} onPress={() => {
        void action.run(async ({ isCurrent }) => {
          const current = await appInputs.getStatus();
          if (!isCurrent() || !current.installed_apps.includes(item.id)) return;
          if (!current.notification_access) {
            await appInputs.openNotificationSettings();
            return;
          }
          await appInputs.setApps([...new Set([...current.selected_apps, item.id])]);
          if (isCurrent()) refresh();
        });
      }}>
        {status.value.notification_access ? '接收' + item.name + '的新通知' : '开启系统通知使用权'}
      </Button>
    ) : null}
  </>;
}
