import React, { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useApp } from '../../app/context';
import { Button } from '../../ui/components';
import { Text } from '../../ui/Text';
import { colors } from '../../ui/theme';
import { growthStyles as s } from './styles';
import type {
  GrowthGoal,
  GrowthJourney,
  GrowthPreferences,
  JourneyStep,
} from './types';
import type { GrowthJourneyController } from './useGrowthJourney';

const choices: Array<{
  kind: GrowthGoal['kind'];
  title: string;
  hint: string;
}> = [
  {
    kind: 'learning',
    title: '学会一样东西',
    hint: '例如：看懂第一个 Solana 程序',
  },
  { kind: 'exercise', title: '多活动一点', hint: '例如：开始每天散步十分钟' },
  { kind: 'general', title: '推进自己的计划', hint: '例如：整理我的书桌' },
];
export function JourneySetup({
  controller,
  preferences,
}: {
  controller: GrowthJourneyController;
  preferences: GrowthPreferences;
}) {
  const selected = preferences.goals[0];
  const [kind, setKind] = useState<GrowthGoal['kind']>(
    selected?.kind ?? 'learning',
  );
  const [goal, setGoal] = useState(selected?.title ?? '');
  const [minutes, setMinutes] = useState(preferences.daily_minutes);
  const [error, setError] = useState('');
  const [consent, setConsent] = useState(preferences.enabled);
  return (
    <View style={[s.panel, { gap: 14 }]} testID="growth-journey-setup">
      <Text style={c.eyebrow}>从一个想改变的地方开始</Text>
      <Text style={c.welcome}>最近，想让哪件事变好一点？</Text>
      <View style={c.choices}>
        {choices.map(choice => (
          <Pressable
            key={choice.kind}
            accessibilityRole="button"
            accessibilityState={{ selected: kind === choice.kind }}
            style={[c.choice, kind === choice.kind && c.chosen]}
            onPress={() => {
              setKind(choice.kind);
              setGoal('');
              setError('');
            }}
          >
            <Text
              style={[s.body, kind === choice.kind && { color: colors.action }]}
            >
              {choice.title}
            </Text>
          </Pressable>
        ))}
      </View>
      <TextInput
        accessibilityLabel="我的成长目标"
        value={goal}
        onChangeText={setGoal}
        maxLength={120}
        placeholder={choices.find(choice => choice.kind === kind)?.hint}
        placeholderTextColor={colors.muted}
        style={c.input}
        multiline
      />
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          setKind('general');
          setGoal('每天为自己完成一件小事，慢慢找到想持续的方向');
        }}
        style={s.textAction}
      >
        <Text style={s.link}>还没想好，先试试每天一件小事</Text>
      </Pressable>
      <Text style={s.section}>每天愿意留多少时间？</Text>
      <View style={c.choices}>
        {[5, 15, 30, ...(![5, 15, 30].includes(minutes) ? [minutes] : [])].map(
          value => (
            <Pressable
              key={value}
              accessibilityRole="button"
              accessibilityLabel={`每天${value}分钟`}
              accessibilityState={{ selected: value === minutes }}
              onPress={() => setMinutes(value)}
              style={[c.minute, value === minutes && c.chosen]}
            >
              <Text style={s.body}>{value} 分钟</Text>
            </Pressable>
          ),
        )}
      </View>
      {!preferences.enabled && (
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: consent }}
          onPress={() => setConsent(value => !value)}
          style={c.consent}
        >
          <Text style={s.body}>{consent ? '☑' : '□'} 开启每日成长</Text>
          <Text style={s.small}>
            用你填写的目标和时间交给当前服务配置的 AI
            准备路线。已允许使用的待办可纳入每日建议，随时可在调整节奏中关闭。
          </Text>
        </Pressable>
      )}
      {!!error && (
        <Text accessibilityRole="alert" style={{ color: colors.danger }}>
          {error}
        </Text>
      )}
      <Button
        loading={controller.action.busy}
        disabled={!consent}
        onPress={() => {
          if (!goal.trim()) {
            setError('写一个你想推进的小目标就好。');
            return;
          }
          setError('');
          void controller.create(goal, kind, minutes);
        }}
      >
        开始我的旅程
      </Button>
      <Text style={s.muted}>
        每次只推进一小步。休息、换节奏，都不会清空已经留下的记录。
      </Text>
    </View>
  );
}

export function JourneyCard({
  journey,
  controller,
  paused,
}: {
  journey: GrowthJourney;
  controller: GrowthJourneyController;
  paused: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [menu, setMenu] = useState(false);
  const [archive, setArchive] = useState(false);
  const { navigate } = useApp();
  const readonly = ['completed', 'archived'].includes(journey.status);
  const current = readonly
    ? undefined
    : journey.steps.find(step => ['current', 'deleted'].includes(step.status));
  const done = journey.completed_steps + journey.skipped_steps;
  const busy = controller.action.busy;
  return (
    <View style={[s.panel, c.route]} testID="growth-journey-card">
      <View style={s.groupHeading}>
        <Text style={c.eyebrow}>
          {journey.status === 'archived' ? '暂存的旅程' : '我的旅程'}
        </Text>
        {!readonly && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="旅程更多选项"
            onPress={() => setArchive(value => !value)}
            style={s.menuAction}
          >
            <Text style={s.link}>···</Text>
          </Pressable>
        )}
      </View>
      <Text style={c.routeTitle}>{journey.goal}</Text>
      {['queued', 'generating'].includes(journey.status) ? (
        <View style={{ gap: 12 }}>
          <Text style={s.small}>
            {controller.pollPaused
              ? '路线还在准备，原有事项可以继续。'
              : '正在把目标拆成一段小旅程…'}
          </Text>
          <Button variant="secondary" onPress={controller.refresh}>
            查看准备进度
          </Button>
        </View>
      ) : journey.status === 'failed' ? (
        <View style={{ gap: 10 }}>
          <Text style={s.small}>
            {journey.error || '这次路线没有准备好，已有记录仍保留。'}
          </Text>
          {journey.can_retry && (
            <Button
              variant="secondary"
              loading={busy}
              onPress={() => {
                void controller.command(journey, 'retry');
              }}
            >
              重新准备路线
            </Button>
          )}
        </View>
      ) : (
        <>
          <Text style={s.small}>
            已走过 {done} / {journey.steps.length} 步
            {journey.skipped_steps
              ? ` · 其中跳过 ${journey.skipped_steps} 步`
              : ''}
          </Text>
          <View style={c.progressDots}>
            {journey.steps.map((step, index) => (
              <View key={step.id} style={c.dotWrap}>
                <View
                  style={[
                    c.dot,
                    step.status === 'completed' && c.dotDone,
                    step.status === 'current' && c.dotCurrent,
                  ]}
                >
                  <Text
                    style={[
                      s.small,
                      step.status === 'completed' && { color: '#39775F' },
                    ]}
                  >
                    {step.status === 'completed'
                      ? '✓'
                      : step.status === 'skipped'
                      ? '—'
                      : index + 1}
                  </Text>
                </View>
                {index < journey.steps.length - 1 && (
                  <View style={c.connector} />
                )}
              </View>
            ))}
          </View>
          {current && (
            <View style={c.current}>
              <View style={s.groupHeading}>
                <Text style={c.eyebrow}>
                  {paused ? '先按自己的节奏来' : '今天，向前一点'}
                </Text>
                <Text style={s.small}>约 {current.estimated_minutes} 分钟</Text>
              </View>
              <View style={c.actions}>
                <Text style={[c.stepTitle, s.flex]} numberOfLines={2}>
                  {current.todo?.title || current.title}
                </Text>
                {current.status !== 'deleted' && (
                  <View style={{ width: 116 }}>
                    <Button
                      loading={busy}
                      disabled={paused && !current.todo}
                      onPress={() => {
                        void controller.begin(journey, current);
                      }}
                    >
                      {current.todo ? '继续这一步' : '开始这一步'}
                    </Button>
                  </View>
                )}
              </View>
              {expanded && (
                <>
                  <Text style={s.small}>{current.description}</Text>
                  <Text style={s.small}>完成标准：{current.criterion}</Text>
                </>
              )}
              {current.status === 'deleted' && (
                <Text style={s.small}>
                  这一步原来的待办已删除。可以跳过，继续下一步。
                </Text>
              )}
              <View style={c.actions}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="AI 陪我做"
                  style={s.textAction}
                  disabled={
                    busy ||
                    (paused && !current.todo) ||
                    current.status === 'deleted'
                  }
                  onPress={() => {
                    void controller.begin(journey, current, true);
                  }}
                >
                  <Text style={s.link}>AI 陪我做 ↗</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="当前成长步骤选项"
                  style={s.textAction}
                  onPress={() => setMenu(value => !value)}
                >
                  <Text style={s.small}>换个节奏 ···</Text>
                </Pressable>
              </View>
              {menu && (
                <View style={c.menu}>
                  <Text style={s.small}>
                    跳过不加成长值。已添加的待办仍保留，可在事项中继续。
                  </Text>
                  <Button
                    variant="ghost"
                    disabled={busy || paused || current.status === 'deleted'}
                    onPress={() => {
                      void controller.begin(journey, current, true, true);
                    }}
                  >
                    太难了，先拆小
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy || paused || current.status === 'deleted'}
                    onPress={() => {
                      void controller.begin(
                        journey,
                        current,
                        true,
                        false,
                        true,
                      );
                    }}
                  >
                    换一种做法
                  </Button>
                  <Button
                    variant="ghost"
                    loading={busy}
                    onPress={() => {
                      void controller.feedback(journey, current, 'skip');
                      setMenu(false);
                    }}
                  >
                    跳过这一步
                  </Button>
                  <Button
                    variant="ghost"
                    onPress={() => navigate({ name: 'growthSettings' })}
                  >
                    今天轻松一点
                  </Button>
                </View>
              )}
            </View>
          )}
          {!current && (
            <Text style={s.body}>
              {journey.status === 'archived'
                ? '这段旅程先放一放，已经添加的待办仍可在事项中继续。'
                : `这一段已经走完。完成 ${journey.completed_steps} 步，跳过 ${journey.skipped_steps} 步，留下的成果都能回看。`}
            </Text>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            onPress={() => setExpanded(value => !value)}
            style={s.textAction}
          >
            <Text style={s.link}>
              {expanded ? '收起路线' : '展开完整路线'} {expanded ? '⌃' : '⌄'}
            </Text>
          </Pressable>
          {expanded &&
            journey.steps.map((step, index) => (
              <RouteStep
                key={step.id}
                step={step}
                index={index}
                journey={journey}
                controller={controller}
              />
            ))}
        </>
      )}
      {archive && (
        <View style={c.menu}>
          <Text style={s.body}>将这段旅程先放一放？</Text>
          <Text style={s.small}>
            成长记录和已添加的待办都会保留，之后可以开始另一个目标。
          </Text>
          <Button
            variant="secondary"
            loading={busy}
            onPress={() => {
              void controller.command(journey, 'archive');
            }}
          >
            确认先放一放
          </Button>
          <Button variant="ghost" onPress={() => setArchive(false)}>
            继续当前旅程
          </Button>
        </View>
      )}
    </View>
  );
}
function RouteStep({
  step,
  index,
  journey,
  controller,
}: {
  step: JourneyStep;
  index: number;
  journey: GrowthJourney;
  controller: GrowthJourneyController;
}) {
  const { navigate } = useApp();
  return (
    <View style={c.routeStep}>
      <Text style={s.badge}>
        {step.status === 'completed'
          ? '✓'
          : step.status === 'skipped'
          ? '—'
          : String(index + 1)}
      </Text>
      <View style={s.flex}>
        <Pressable
          accessibilityRole={step.todo ? 'button' : undefined}
          disabled={!step.todo}
          onPress={() =>
            step.todo && navigate({ name: 'todo', id: step.todo.id })
          }
        >
          <Text style={s.body}>{step.title}</Text>
          <Text style={s.muted}>
            {step.status === 'completed'
              ? '已确认完成'
              : step.status === 'skipped'
              ? '已跳过'
              : step.status === 'current'
              ? '正在推进'
              : '后续步骤'}
          </Text>
        </Pressable>
        {step.status === 'completed' && journey.status !== 'archived' && (
          <View style={c.feedback}>
            <Text style={s.small}>这一步感觉怎样？</Text>
            {(
              [
                ['too_hard', '有点难'],
                ['just_right', '刚刚好'],
                ['too_easy', '太简单'],
              ] as const
            ).map(([value, label]) => (
              <Pressable
                key={value}
                accessibilityRole="button"
                accessibilityLabel={`${step.title}：${label}`}
                accessibilityState={{ selected: step.difficulty === value }}
                disabled={controller.action.busy}
                onPress={() => {
                  void controller.feedback(journey, step, value);
                }}
                style={[c.rating, step.difficulty === value && c.chosen]}
              >
                <Text style={s.small}>{label}</Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>
    </View>
  );
}
export const journeyStyles = StyleSheet.create({
  compactHero: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 10,
    marginBottom: 12,
  },
  title: { color: colors.ink, fontSize: 20, lineHeight: 29, fontWeight: '500' },
  collection: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  collectible: {
    backgroundColor: colors.surface,
    borderRadius: 18,
    padding: 14,
    flexGrow: 1,
    flexBasis: '44%',
    minHeight: 100,
    gap: 7,
  },
});
const c = StyleSheet.create({
  eyebrow: {
    color: colors.action,
    fontSize: 12,
    lineHeight: 20,
    fontWeight: '500',
  },
  welcome: {
    color: colors.ink,
    fontSize: 21,
    lineHeight: 31,
    fontWeight: '500',
  },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choice: {
    borderRadius: 13,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.line,
    minHeight: 44,
  },
  chosen: { backgroundColor: colors.blueLight, borderColor: colors.accent },
  input: {
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    borderRadius: 14,
    padding: 14,
    minHeight: 76,
    fontSize: 15,
    lineHeight: 24,
    color: colors.ink,
    textAlignVertical: 'top',
  },
  minute: {
    minWidth: 75,
    minHeight: 44,
    padding: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 13,
  },
  consent: { minHeight: 44, gap: 5 },
  route: { marginBottom: 16, gap: 9 },
  routeTitle: {
    color: colors.ink,
    fontSize: 19,
    lineHeight: 28,
    fontWeight: '500',
  },
  progressDots: { flexDirection: 'row', marginVertical: 9 },
  dotWrap: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  dot: {
    width: 27,
    height: 27,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.cream,
  },
  dotDone: { backgroundColor: '#E7F3EC' },
  dotCurrent: {
    borderWidth: 1.5,
    borderColor: colors.accent,
    backgroundColor: colors.blueLight,
  },
  connector: { height: 1, backgroundColor: colors.line, flex: 1 },
  current: {
    borderRadius: 15,
    backgroundColor: '#F2F5FF',
    padding: 13,
    gap: 9,
  },
  stepTitle: {
    color: colors.ink,
    fontSize: 17,
    lineHeight: 26,
    fontWeight: '500',
  },
  actions: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  menu: {
    borderRadius: 13,
    padding: 12,
    backgroundColor: colors.cream,
    gap: 8,
  },
  routeStep: {
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderColor: colors.line,
  },
  feedback: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 5,
    marginTop: 5,
  },
  rating: {
    paddingHorizontal: 9,
    paddingVertical: 8,
    minHeight: 44,
    justifyContent: 'center',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
  },
});
