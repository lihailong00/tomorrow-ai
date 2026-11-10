import React, { useEffect, useMemo, useState } from 'react';
import { AppState, Pressable, View } from 'react-native';
import { useApp } from '../../app/context';
import { Text } from '../../ui/Text';
import { growthStyles as s } from './styles';
import { colors } from '../../ui/theme';

/** A local aid only. Time elapsed never writes a completion, minutes or XP. */
export function GrowthFocusTimer({
  todoId,
  minutes,
}: {
  todoId: string;
  minutes?: number | null;
}) {
  const { api, user } = useApp();
  const owner = useMemo(
    () => ({ api, userId: user?.id, todoId }),
    [api, user?.id, todoId],
  );
  const target = Math.max(1, Math.min(120, minutes || 5)) * 60;
  const [session, setSession] = useState({
    owner,
    elapsed: 0,
    started: 0,
    running: false,
  });
  const [clock, setClock] = useState(Date.now());
  const live =
    session.owner === owner
      ? session
      : { owner, elapsed: 0, started: 0, running: false };
  const elapsed = Math.min(
    target,
    live.elapsed +
      (live.running
        ? Math.max(0, Math.floor((clock - live.started) / 1000))
        : 0),
  );
  useEffect(() => {
    if (!live.running) return;
    const update = () => {
      if (!['background', 'inactive'].includes(AppState.currentState))
        setClock(Date.now());
    };
    const timer = setInterval(update, 1000);
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') update();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [live.running, owner]);
  useEffect(() => {
    if (live.running && elapsed >= target)
      setSession({ owner, elapsed: target, started: 0, running: false });
  }, [elapsed, target, owner, live.running]);
  const remaining = Math.max(0, target - elapsed);
  return (
    <View style={[s.panel, { marginVertical: 12 }]} testID="growth-focus-timer">
      <View style={s.groupHeading}>
        <Text style={s.section}>留给自己的 {Math.round(target / 60)} 分钟</Text>
        <Text style={[s.section, { color: colors.action }]}>
          {String(Math.floor(remaining / 60)).padStart(2, '0')}:
          {String(remaining % 60).padStart(2, '0')}
        </Text>
      </View>
      <Text style={s.small}>
        {elapsed >= target
          ? '这一小段时间到了。完成了哪些内容，由你按实际情况确认。'
          : '先做眼前的一小步。计时不会自动完成待办，也不会记录成活动时长。'}
      </Text>
      <View style={[s.chips, { gap: 16 }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            live.running
              ? '暂停专注计时'
              : elapsed >= target
              ? '重新开始专注计时'
              : '开始专注计时'
          }
          onPress={() => {
            const now = Date.now();
            setClock(now);
            setSession(
              live.running
                ? {
                    owner,
                    elapsed: Math.min(
                      target,
                      live.elapsed +
                        Math.max(0, Math.floor((now - live.started) / 1000)),
                    ),
                    started: 0,
                    running: false,
                  }
                : {
                    owner,
                    elapsed: elapsed >= target ? 0 : elapsed,
                    started: now,
                    running: true,
                  },
            );
          }}
          style={s.textAction}
        >
          <Text style={s.link}>
            {live.running
              ? '暂停'
              : elapsed >= target
              ? '再来一小段'
              : elapsed
              ? '继续计时'
              : '开始专注'}
          </Text>
        </Pressable>
        {elapsed > 0 && (
          <Pressable
            accessibilityRole="button"
            onPress={() =>
              setSession({ owner, elapsed: 0, started: 0, running: false })
            }
            style={s.textAction}
          >
            <Text style={s.small}>重置</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}
