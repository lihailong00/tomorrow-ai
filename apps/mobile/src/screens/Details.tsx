import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  Switch,
  Text,
  View,
} from 'react-native';
import { newRequestId } from '../api/client';
import { useAction, useApp, useResource } from '../app/context';
import {
  frequencies,
  isActiveTask,
  Memory,
  memoryKinds,
  MemoryKind,
  Schedule,
  taskStatuses,
} from '../domain/types';
import { platform } from '../platform/ports';
import {
  Button,
  Card,
  Empty,
  ErrorNotice,
  Field,
  Loading,
  Notice,
  Pill,
  Section,
} from '../ui/components';
import { ResultText } from '../ui/ResultText';
import { colors, styles as s } from '../ui/theme';
import { Icon } from '../ui/visuals';

export function TaskDetailScreen({ id }: { id: string }) {
  const { api, revision, invalidate, navigate, formatDate } = useApp();
  const data = useResource(() => api.task(id), [api, id, revision]);
  const action = useAction();
  const [showSteps, setShowSteps] = useState(false);
  useEffect(() => {
    if (!data.value || !isActiveTask(data.value)) {
      return;
    }
    const timer = setInterval(data.refresh, 2500);
    return () => clearInterval(timer);
  }, [data.value, data.refresh]);
  const task = data.value;
  const cancelTask = () =>
    Alert.alert('停止这项任务？', '已生成的内容会保留，后续步骤将停止。', [
      { text: '继续执行', style: 'cancel' },
      {
        text: '停止任务',
        style: 'destructive',
        onPress: () =>
          action.run(async () => {
            await api.cancelTask(id);
            invalidate();
          }),
      },
    ]);
  return (
    <ScrollView
      refreshControl={
        <RefreshControl
          refreshing={data.loading && Boolean(task)}
          onRefresh={data.refresh}
        />
      }
      contentContainerStyle={s.content}
    >
      <Text style={s.title}>任务详情</Text>
      <ErrorNotice message={data.error} retry={data.refresh} />
      {data.loading && !task && <Loading />}
      {task && (
        <>
          <View
            style={{
              marginTop: 20,
              marginBottom: 12,
              alignItems: 'flex-start',
            }}
          >
            <Pill
              tone={
                task.status === 'waiting_approval' ||
                task.status === 'uncertain'
                  ? 'amber'
                  : task.status === 'failed'
                  ? 'red'
                  : 'green'
              }
            >
              {taskStatuses[task.status]}
            </Pill>
          </View>
          <Text
            style={[
              s.cardTitle,
              { fontSize: 21, lineHeight: 30, fontWeight: '500' },
            ]}
          >
            {task.title}
          </Text>
          <Text style={[s.small, s.topGap]}>
            创建于 {formatDate(task.created_at)} ·{' '}
            {task.model_mode === 'local' ? '本地演示模式' : '在线模型'}
          </Text>
          {task.status === 'queued' && (
            <Notice>
              任务已保存在服务端，等待执行器处理。若长时间没有变化，请确认后台任务服务已启动。
            </Notice>
          )}
          {task.status === 'uncertain' && (
            <Notice>
              当前结果尚不能确认。请先核实已有结果，避免再次提交造成重复。
            </Notice>
          )}
          {task.status === 'waiting_approval' && (
            <Card
              style={{
                marginTop: 22,
                backgroundColor: '#FFF0E8',
                borderColor: '#F6E2D7',
              }}
            >
              <View style={[s.row, { gap: 9 }]}>
                <Icon name="clock" size={19} color="#B37B57" />
                <Text style={s.cardTitle}>等待你的确认</Text>
              </View>
              <Text style={[s.small, { marginTop: 14, marginBottom: 5 }]}>
                助手将按以下指令继续
              </Text>
              <Text selectable style={s.body}>
                {task.instruction}
              </Text>
              <Text style={[s.small, { marginTop: 12 }]}>
                当前支持资料整理与文本生成，不会发送邮件或修改外部日历。
              </Text>
              <View style={s.topGap}>
                <Button
                  loading={action.busy}
                  onPress={() =>
                    Alert.alert('确认继续这项任务？', task.instruction, [
                      { text: '再想一下', style: 'cancel' },
                      {
                        text: '确认继续',
                        onPress: () =>
                          action.run(async () => {
                            await api.approveTask(id);
                            invalidate();
                          }),
                      },
                    ])
                  }
                >
                  批准并继续
                </Button>
                <Button
                  variant="ghost"
                  loading={action.busy}
                  onPress={cancelTask}
                >
                  取消任务
                </Button>
              </View>
            </Card>
          )}
          {task.error && <ErrorNotice message={task.error} />}
          {task.result && (
            <>
              <Section title="任务成果" />
              <Card style={{ padding: 0, overflow: 'hidden' }}>
                <View
                  style={[
                    s.row,
                    {
                      gap: 10,
                      paddingHorizontal: 20,
                      paddingVertical: 16,
                      backgroundColor: '#F6F8FF',
                      borderBottomWidth: 1,
                      borderBottomColor: '#EEF0F7',
                    },
                  ]}
                >
                  <Icon name="file" color="#5584E8" size={21} />
                  <View style={s.fill}>
                    <Text style={[s.body, { fontWeight: '500' }]}>
                      {task.title}
                    </Text>
                    <Text style={s.small}>整理文稿</Text>
                  </View>
                </View>
                <View style={{ padding: 20 }}>
                  <ResultText content={task.result} />
                  <View style={s.divider} />
                  <Text style={s.small}>
                    依据：本次指令与服务端当前可用资料。未配置连接器时不读取外部账号。
                  </Text>
                  {task.model_mode === 'local' && (
                    <Notice>
                      这是本地规则生成的结果，未调用在线大模型或进行网页搜索。
                    </Notice>
                  )}
                  <Button
                    variant="secondary"
                    onPress={() =>
                      action.run(() =>
                        platform.share(task.result || '', task.title),
                      )
                    }
                  >
                    分享成果
                  </Button>
                </View>
              </Card>
              <Button
                variant="ghost"
                onPress={() =>
                  navigate({
                    name: 'chat',
                    prompt:
                      '继续讨论这个任务：' + task.title + '\n\n' + task.result,
                  })
                }
              >
                继续聊这份成果
              </Button>
            </>
          )}
          {task.status !== 'waiting_approval' && (
            <>
              <Section title="任务内容" />
              <Card
                style={{
                  backgroundColor: '#F1F4FA',
                  borderColor: 'transparent',
                }}
              >
                <Text selectable style={s.body}>
                  {task.instruction}
                </Text>
              </Card>
            </>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={showSteps ? '收起执行过程' : '展开执行过程'}
            accessibilityState={{ expanded: showSteps }}
            onPress={() => setShowSteps(!showSteps)}
            style={[s.between, { paddingVertical: 18, minHeight: 54 }]}
          >
            <View style={[s.row, { gap: 8 }]}>
              <Icon name="history" size={17} color={colors.secondary} />
              <Text style={s.small}>执行过程 · {task.steps.length} 个步骤</Text>
            </View>
            <Text style={s.small}>{showSteps ? '收起' : '展开'}</Text>
          </Pressable>
          {showSteps && (
            <View style={{ paddingHorizontal: 6, paddingBottom: 12 }}>
              {task.steps.length ? (
                task.steps.map((step, index) => (
                  <View
                    key={step.id}
                    style={{
                      flexDirection: 'row',
                      gap: 12,
                      paddingBottom: index === task.steps.length - 1 ? 0 : 20,
                    }}
                  >
                    <View
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: 12,
                        backgroundColor:
                          step.status === 'completed' ? '#EAF1FF' : '#EEEAFE',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {step.status === 'completed' ? (
                        <Icon name="check" size={13} color="#5584E8" />
                      ) : (
                        <Text style={{ fontSize: 11, color: colors.secondary }}>
                          {step.status === 'failed' ? '!' : index + 1}
                        </Text>
                      )}
                    </View>
                    <View style={s.fill}>
                      <Text style={[s.body, { fontSize: 13 }]}>
                        {step.title}
                      </Text>
                      {step.detail && (
                        <Text style={s.small}>{step.detail}</Text>
                      )}
                    </View>
                  </View>
                ))
              ) : (
                <Text style={s.small}>执行后会记录具体步骤。</Text>
              )}
            </View>
          )}
          <ErrorNotice message={action.error} />
          {['queued', 'running'].includes(task.status) && (
            <Button
              variant="secondary"
              loading={action.busy}
              onPress={cancelTask}
            >
              停止任务
            </Button>
          )}
          <Text
            selectable
            style={[s.small, { marginTop: 24, textAlign: 'center' }]}
          >
            任务编号 {task.id}
          </Text>
        </>
      )}
    </ScrollView>
  );
}

export function NewTaskScreen() {
  const { api, navigate, invalidate } = useApp();
  const [instruction, setInstruction] = useState('');
  const [approval, setApproval] = useState(false);
  const request = useRef({
    instruction: '',
    approval: false,
    id: newRequestId(),
  });
  const action = useAction();
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={s.content}
    >
      <Text style={s.title}>新建任务</Text>
      <Text style={s.subtitle}>告诉我目标，我来整理思路并继续处理。</Text>
      <Field
        label="希望帮你完成什么"
        placeholder="例如：结合我的目标和当前项目，整理一份本周行动计划。"
        multiline
        value={instruction}
        onChangeText={setInstruction}
        maxLength={12000}
        style={{ minHeight: 190 }}
      />
      <View style={[s.row, s.gap, { marginVertical: 22 }]}>
        <View style={s.fill}>
          <Text style={s.cardTitle}>执行前先让我确认</Text>
          <Text style={s.small}>先保存任务，待你在详情页批准后执行。</Text>
        </View>
        <Switch
          accessibilityLabel="执行前需要我的确认"
          value={approval}
          onValueChange={setApproval}
          trackColor={{ false: '#DDE1EA', true: '#AFC7FA' }}
          thumbColor={approval ? '#5584E8' : colors.surface}
        />
      </View>
      <Notice>
        任务由服务端执行并保存进度。当前首版支持资料整理与文本成果；外部账号操作以能力页状态为准。
      </Notice>
      <ErrorNotice message={action.error} />
      <Button
        loading={action.busy}
        disabled={!instruction.trim()}
        onPress={() =>
          action.run(async () => {
            const text = instruction.trim();
            if (!text) {
              return;
            }
            if (
              request.current.instruction !== text ||
              request.current.approval !== approval
            ) {
              request.current = {
                instruction: text,
                approval,
                id: newRequestId(),
              };
            }
            const task = await api.createTask(
              text,
              approval,
              request.current.id,
            );
            invalidate();
            navigate({ name: 'task', id: task.id });
          })
        }
      >
        开始任务
      </Button>
    </ScrollView>
  );
}

export function MemoryEditor({ memory }: { memory?: Memory }) {
  const { api, back, invalidate, formatDate } = useApp();
  const [title, setTitle] = useState(memory?.title ?? '');
  const [content, setContent] = useState(memory?.content ?? '');
  const [kind, setKind] = useState<MemoryKind>(memory?.kind ?? 'preference');
  const action = useAction();
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={s.content}
    >
      <Text style={s.title}>{memory ? '编辑记忆' : '添加记忆'}</Text>
      <Text style={s.subtitle}>你的明确说明，会用于之后的回答与任务。</Text>
      <Text style={s.label}>记忆类型</Text>
      <View style={[s.row, { flexWrap: 'wrap', gap: 8 }]}>
        {Object.entries(memoryKinds).map(([id, label]) => (
          <Pressable
            key={id}
            onPress={() => setKind(id as MemoryKind)}
            style={{
              backgroundColor: kind === id ? '#EAF1FF' : colors.surface,
              borderRadius: 20,
              paddingHorizontal: 14,
              paddingVertical: 9,
            }}
          >
            <Text
              style={[
                s.small,
                { color: kind === id ? '#5584E8' : colors.secondary },
              ]}
            >
              {label}
            </Text>
          </Pressable>
        ))}
      </View>
      <Field
        label="给它一个名字（可选）"
        value={title}
        onChangeText={setTitle}
        placeholder="例如：我的工作节奏"
        maxLength={200}
      />
      <Field
        label="希望助手记住什么"
        multiline
        value={content}
        onChangeText={setContent}
        maxLength={10000}
        placeholder="比如：我上午更专注，希望把重要工作放在午饭前。"
        style={{ minHeight: 175 }}
      />
      {memory && (
        <Text style={[s.small, s.topGap]}>
          来源：{memory.source} · 更新于 {formatDate(memory.updated_at)}
          {'\n'}版本 {memory.version} · 修改发生冲突时，请返回刷新后再编辑。
        </Text>
      )}
      <ErrorNotice message={action.error} />
      <View style={{ marginTop: 24 }}>
        <Button
          loading={action.busy}
          disabled={!content.trim()}
          onPress={() =>
            action.run(async () => {
              await api.saveMemory(
                {
                  title: title.trim() || undefined,
                  content: content.trim(),
                  kind,
                  ...(!memory
                    ? { source: '用户主动添加' }
                    : { version: memory.version }),
                },
                memory?.id,
              );
              invalidate();
              back();
            })
          }
        >
          {memory ? '保存修改' : '保存记忆'}
        </Button>
      </View>
      {memory && (
        <View style={s.topGap}>
          <Button
            variant="ghost"
            loading={action.busy}
            onPress={() =>
              Alert.alert(
                '删除这条记忆？',
                '删除后不再用于新的回答。原始会话不会一起删除。',
                [
                  { text: '保留', style: 'cancel' },
                  {
                    text: '删除记忆',
                    style: 'destructive',
                    onPress: () =>
                      action.run(async () => {
                        await api.deleteMemory(memory.id);
                        invalidate();
                        back();
                      }),
                  },
                ],
              )
            }
          >
            删除这条记忆
          </Button>
        </View>
      )}
    </ScrollView>
  );
}

export function ScheduleEditor({ schedule }: { schedule?: Schedule }) {
  const { api, user, back, invalidate, formatDate } = useApp();
  const [title, setTitle] = useState(schedule?.title ?? '');
  const [instruction, setInstruction] = useState(schedule?.instruction ?? '');
  const [frequency, setFrequency] = useState<Schedule['frequency']>(
    schedule?.frequency ?? 'daily',
  );
  const [time, setTime] = useState(schedule?.time ?? '08:00');
  const [timezone, setTimezone] = useState(
    schedule?.timezone ?? user?.timezone ?? 'Asia/Shanghai',
  );
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
  const action = useAction();
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={s.content}
    >
      <Text style={s.title}>{schedule ? '编辑计划' : '新建计划'}</Text>
      <Text style={s.subtitle}>在指定时间，自动为你完成任务。</Text>
      <Field
        label="计划名称"
        placeholder="例如：晨间简报"
        value={title}
        onChangeText={setTitle}
        maxLength={200}
      />
      <Field
        label="每次需要做什么"
        placeholder="结合我的任务和记忆，整理今天最值得关注的事情。"
        multiline
        value={instruction}
        onChangeText={setInstruction}
        maxLength={10000}
      />
      <Text style={s.label}>执行频率</Text>
      <View style={[s.row, { flexWrap: 'wrap', gap: 8 }]}>
        {Object.entries(frequencies).map(([id, label]) => (
          <Pressable
            key={id}
            onPress={() => setFrequency(id as Schedule['frequency'])}
            style={{
              backgroundColor: frequency === id ? '#EAF1FF' : colors.surface,
              borderRadius: 20,
              paddingHorizontal: 16,
              paddingVertical: 10,
            }}
          >
            <Text
              style={[
                s.small,
                { color: frequency === id ? '#5584E8' : colors.secondary },
              ]}
            >
              {label}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={[s.row, { gap: 12 }]}>
        <View style={{ flex: 0.6 }}>
          <Field
            label="执行时间（24 小时）"
            placeholder="08:00"
            value={time}
            onChangeText={setTime}
            maxLength={5}
            keyboardType="numbers-and-punctuation"
          />
        </View>
        <View style={s.fill}>
          <Field
            label="时区"
            value={timezone}
            onChangeText={setTimezone}
            placeholder="Asia/Shanghai"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
      </View>
      {frequency === 'once' && (
        <Notice>一次性计划在这个时区的下一次指定时间执行。</Notice>
      )}
      {frequency === 'weekly' && (
        <Notice>每周计划的具体下一次运行日期以保存后显示的时间为准。</Notice>
      )}
      <View
        style={[s.row, { justifyContent: 'space-between', marginVertical: 20 }]}
      >
        <Text style={s.cardTitle}>启用这个计划</Text>
        <Switch
          accessibilityLabel="启用计划"
          value={enabled}
          onValueChange={setEnabled}
          trackColor={{ false: '#DDE1EA', true: '#AFC7FA' }}
          thumbColor={enabled ? '#5584E8' : colors.surface}
        />
      </View>
      {schedule && (
        <Text style={s.small}>
          下次运行：{formatDate(schedule.next_run_at, schedule.timezone)}
          {schedule.last_run_at
            ? '\n上次运行：' +
              formatDate(schedule.last_run_at, schedule.timezone)
            : ''}
        </Text>
      )}
      <ErrorNotice message={action.error} />
      <View style={s.topGap}>
        <Button
          loading={action.busy}
          disabled={!title.trim() || !instruction.trim()}
          onPress={() =>
            action.run(async () => {
              if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
                throw new Error('时间格式应为 08:00 或 18:30。');
              }
              try {
                new Intl.DateTimeFormat('zh-CN', {
                  timeZone: timezone,
                }).format();
              } catch {
                throw new Error('请输入有效时区。');
              }
              await api.saveSchedule(
                {
                  title: title.trim(),
                  instruction: instruction.trim(),
                  frequency,
                  time,
                  timezone,
                  enabled,
                },
                schedule?.id,
              );
              invalidate();
              back();
            })
          }
        >
          {schedule ? '保存计划' : '保存并开始'}
        </Button>
      </View>
      {schedule && (
        <View style={s.topGap}>
          <Button
            variant="ghost"
            loading={action.busy}
            onPress={() =>
              Alert.alert(
                '删除这个计划？',
                '以后不会再自动运行，已经产生的任务与结果会保留。',
                [
                  { text: '保留', style: 'cancel' },
                  {
                    text: '删除计划',
                    style: 'destructive',
                    onPress: () =>
                      action.run(async () => {
                        await api.deleteSchedule(schedule.id);
                        invalidate();
                        back();
                      }),
                  },
                ],
              )
            }
          >
            删除计划
          </Button>
        </View>
      )}
    </ScrollView>
  );
}

export function NotificationsScreen() {
  const { api, navigate, invalidate, formatDate } = useApp();
  const data = useResource(() => api.notifications(), [api]);
  const action = useAction();
  return (
    <ScrollView
      contentContainerStyle={s.content}
      refreshControl={
        <RefreshControl
          refreshing={data.loading && Boolean(data.value)}
          onRefresh={data.refresh}
        />
      }
    >
      <Text style={s.title}>消息</Text>
      <Text style={s.subtitle}>任务进展和待确认事项。</Text>
      <ErrorNotice message={data.error} retry={data.refresh} />
      <ErrorNotice message={action.error} />
      {data.loading && !data.value && <Loading />}
      {data.value &&
        (data.value.items.length ? (
          <View style={{ marginTop: 24 }}>
            {data.value.items.map(item => (
              <Pressable
                key={item.id}
                onPress={() =>
                  action.run(async () => {
                    await api.readNotification(item.id);
                    invalidate();
                    data.refresh();
                    if (item.task_id) {
                      navigate({ name: 'task', id: item.task_id });
                    }
                  })
                }
              >
                <Card
                  style={{
                    backgroundColor: item.read ? colors.surface : '#EEF3FF',
                  }}
                >
                  <View style={s.between}>
                    <View style={[s.row, { flex: 1, gap: 8 }]}>
                      {!item.read && (
                        <View
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: 3,
                            backgroundColor: '#5584E8',
                          }}
                        />
                      )}
                      <Text style={[s.cardTitle, { flex: 1 }]}>
                        {item.title}
                      </Text>
                    </View>
                    <Icon
                      name="chevronRight"
                      size={16}
                      color={colors.secondary}
                    />
                  </View>
                  <Text style={[s.body, { marginTop: 7 }]}>{item.body}</Text>
                  <Text style={[s.small, s.topGap]}>
                    {formatDate(item.created_at)}
                    {item.read ? ' · 已读' : ' · 点击标为已读'}
                  </Text>
                </Card>
              </Pressable>
            ))}
          </View>
        ) : (
          <Empty
            symbol="◷"
            title="此刻，没有需要打扰你的事"
            body="有新的进展时，回来就能看到。"
          />
        ))}
    </ScrollView>
  );
}

export function ArtifactsScreen() {
  const { api, navigate, formatDate } = useApp();
  const data = useResource(() => api.artifacts(), [api]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const action = useAction();
  return (
    <ScrollView
      contentContainerStyle={s.content}
      refreshControl={
        <RefreshControl
          refreshing={data.loading && Boolean(data.value)}
          onRefresh={data.refresh}
        />
      }
    >
      <Text style={s.title}>我的成果</Text>
      <Text style={s.subtitle}>整理好的文稿，随时查看和分享。</Text>
      <ErrorNotice message={data.error} retry={data.refresh} />
      <ErrorNotice message={action.error} />
      {data.loading && !data.value && <Loading />}
      {data.value &&
        (data.value.items.length ? (
          <View style={{ marginTop: 24 }}>
            {data.value.items.map(item => (
              <Card key={item.id}>
                <Pressable
                  onPress={() =>
                    setExpanded(expanded === item.id ? null : item.id)
                  }
                >
                  <View style={s.between}>
                    <View style={[s.row, { gap: 7 }]}>
                      <Icon name="file" size={17} color="#5584E8" />
                      <Text style={s.small}>整理文稿</Text>
                    </View>
                    <Text style={s.small}>{formatDate(item.created_at)}</Text>
                  </View>
                  <Text style={[s.cardTitle, s.topGap]}>{item.title}</Text>
                  {expanded !== item.id && (
                    <Text numberOfLines={3} style={[s.small, { marginTop: 9 }]}>
                      {item.content.replace(/[#*_`]/g, '')}
                    </Text>
                  )}
                  <Text style={[s.link, s.topGap]}>
                    {expanded === item.id ? '收起文稿' : '查看全文'}
                  </Text>
                </Pressable>
                {expanded === item.id && (
                  <View style={s.topGap}>
                    <ResultText content={item.content} />
                    <View style={s.topGap}>
                      <Button
                        variant="secondary"
                        onPress={() =>
                          action.run(() =>
                            platform.share(item.content, item.title),
                          )
                        }
                      >
                        分享内容
                      </Button>
                    </View>
                    <Button
                      variant="ghost"
                      onPress={() =>
                        navigate({ name: 'task', id: item.task_id })
                      }
                    >
                      查看原始任务
                    </Button>
                  </View>
                )}
              </Card>
            ))}
          </View>
        ) : (
          <Empty
            symbol="▤"
            title="这里会收好每一份成果"
            body="完成一个资料整理或简报任务后，结果就会出现在这里。"
            action="交代一个任务"
            onAction={() => navigate({ name: 'newTask' })}
          />
        ))}
    </ScrollView>
  );
}
