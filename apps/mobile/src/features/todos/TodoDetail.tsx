import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useAction, useApp, useResource } from '../../app/context';
import { ApiError, newRequestId } from '../../api/client';
import type { Task } from '../../domain/types';
import { taskStatuses } from '../../domain/types';
import { platform } from '../../platform/ports';
import {
  Button,
  ErrorNotice,
  Field,
  Loading,
  Notice,
} from '../../ui/components';
import { Text } from '../../ui/Text';
import { getTodo, prepareTodo, updateTodo } from './api';
import { todoKinds, validateMinutes } from './model';
import { TodoEditor } from './TodoEditor';
import type { Todo, UpdateTodo } from './types';
import { todoStyles as s } from './ui';
import { confirmTodoAction, getTodoActions } from '../growth/api';
import { useGrowthData } from '../growth/context';
import { GrowthFocusTimer } from '../growth/GrowthFocusTimer';

const preparationPendingNotice = '妥啦正在准备内容。你可以稍后回来查看。';

export function TodoDetail({ id }: { id: string }) {
  const { api, user } = useApp();
  const owner = useMemo(
    () => ({ api, userId: user?.id, id }),
    [api, user?.id, id],
  );
  const latest = useRef<{ owner: typeof owner; todo?: Todo }>({ owner });
  if (latest.current.owner !== owner) latest.current = { owner };
  const data = useResource(async () => {
    const fetched = await getTodo(api, id);
    if (latest.current.owner !== owner) return fetched;
    // A poll begun before a successful edit must not overwrite that newer edit.
    if (latest.current.todo && latest.current.todo.version > fetched.version)
      return latest.current.todo;
    latest.current.todo = fetched;
    return fetched;
  }, [owner]);
  const { loading, error: loadError, refresh: refreshData } = data;
  const todo = data.value;
  const polls = useRef({ api, id, count: 0 });
  const [pollPaused, setPollPaused] = useState(false);
  useEffect(() => {
    polls.current = { api, id, count: 0 };
    setPollPaused(false);
  }, [api, user?.id, id]);
  useEffect(() => {
    if (
      !todo?.linked_task_id ||
      todo.draft ||
      ['completed', 'dismissed'].includes(todo.status) ||
      loadError ||
      pollPaused
    )
      return;
    // Read the durable todo only; preparation never completes the personal item.
    const timer = setTimeout(() => {
      if (++polls.current.count > 60) {
        setPollPaused(true);
        return;
      }
      refreshData();
    }, 4000);
    return () => clearTimeout(timer);
  }, [todo, loading, loadError, refreshData, pollPaused]);
  return (
    <ScrollView
      contentContainerStyle={s.page}
      keyboardShouldPersistTaps="handled"
    >
      <ErrorNotice message={data.error} retry={data.refresh} />
      {data.loading && !todo && <Loading />}
      {todo && (
        <TodoContent
          key={api.baseUrl + ':' + user?.id + ':' + todo.id}
          todo={todo}
          onUpdate={updated => {
            if (latest.current.owner !== owner) return;
            latest.current.todo = updated;
            data.setValue(updated);
          }}
          refresh={() => {
            polls.current.count = 0;
            setPollPaused(false);
            data.refresh();
          }}
          pollPaused={pollPaused}
          onPreparationStopped={() => setPollPaused(true)}
        />
      )}
    </ScrollView>
  );
}

function TodoContent({
  todo,
  onUpdate,
  refresh,
  pollPaused,
  onPreparationStopped,
}: {
  todo: Todo;
  onUpdate: (todo: Todo) => void;
  refresh: () => void;
  pollPaused: boolean;
  onPreparationStopped: () => void;
}) {
  const { api, user, navigate, invalidate, formatDate } = useApp();
  const action = useAction();
  const growth = useGrowthData();
  const prefetchReward = growth?.prefetchReward;
  useEffect(() => {
    void prefetchReward?.(todo.id);
  }, [prefetchReward, todo.id, todo.version]);
  const [editing, setEditing] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [draft, setDraft] = useState(todo.draft ?? '');
  const [notes, setNotes] = useState(todo.progress_notes ?? '');
  const [minutes, setMinutes] = useState('');
  const [notice, setNotice] = useState('');
  const [task, setTask] = useState<Task>();
  const draftValue = useRef(draft);
  const notesValue = useRef(notes);
  const changeDraft = (value: string) => {
    draftValue.current = value;
    setDraft(value);
  };
  const changeNotes = (value: string) => {
    notesValue.current = value;
    setNotes(value);
  };
  const confirmedIntents = useRef(
    new Map<string, Parameters<typeof confirmTodoAction>[2]>(),
  );
  const replyRecord = useResource(
    () =>
      todo.kind === 'communication'
        ? getTodoActions(api, todo.id)
        : Promise.resolve(null),
    [api, user?.id, todo.id, todo.kind, todo.version],
  );
  const prepareId = useRef('');
  const previous = useRef({ draft: todo.draft, notes: todo.progress_notes });
  useEffect(() => {
    if (todo.draft && notice === preparationPendingNotice) setNotice('');
  }, [todo.draft, notice]);
  useEffect(() => {
    // A preparation result may arrive while the progress editor is open.
    if (
      previous.current.draft !== todo.draft &&
      draftValue.current === (previous.current.draft ?? '')
    )
      changeDraft(todo.draft ?? '');
    if (
      previous.current.notes !== todo.progress_notes &&
      notesValue.current === (previous.current.notes ?? '')
    )
      changeNotes(todo.progress_notes ?? '');
    previous.current = { draft: todo.draft, notes: todo.progress_notes };
  }, [todo.draft, todo.progress_notes]);
  const save = (patch: Omit<UpdateTodo, 'version'>, message?: string) =>
    action.run(async guard => {
      const observesCompletion =
        patch.status === 'completed' ||
        (todo.status === 'completed' && !!patch.status);
      const observation = growth?.prepareReward(todo.id) ?? null;
      if (!guard.isCurrent()) return;
      const updated = await updateTodo(api, todo.id, {
        ...patch,
        version: todo.version,
      });
      if (!guard.isCurrent()) return;
      onUpdate(updated);
      invalidate();
      setEditing(false);
      setNotice(message ?? '已保存。');
      if (observesCompletion) void growth?.confirmReward(observation);
    });
  const confirmedAction = (
    kind: 'replied' | 'undo_replied' | 'exercise_completed',
    patch:
      | Pick<
          Parameters<typeof confirmTodoAction>[2],
          'draft' | 'actual_minutes' | 'progress_notes'
        >
      | (() => Pick<
          Parameters<typeof confirmTodoAction>[2],
          'draft' | 'actual_minutes' | 'progress_notes'
        >),
    message: string,
  ) =>
    action.run(async guard => {
      let intent = confirmedIntents.current.get(kind);
      if (!intent) {
        const details = typeof patch === 'function' ? patch() : patch;
        intent = {
          kind,
          version: todo.version,
          client_request_id: newRequestId(),
          ...details,
        };
        confirmedIntents.current.set(kind, intent);
      }
      const observation = growth?.prepareReward(todo.id) ?? null;
      if (!guard.isCurrent()) return;
      try {
        let compatibility = false;
        let result;
        try {
          result = await confirmTodoAction(api, todo.id, intent);
        } catch (failure) {
          // A definite missing method may use the old CAS endpoint. An uncertain
          // outcome must keep the original intent and never send a second action.
          if (
            !(failure instanceof ApiError) ||
            ![404, 405].includes(failure.status) ||
            kind === 'undo_replied'
          )
            throw failure;
          if (!guard.isCurrent()) return;
          const legacy = await updateTodo(api, todo.id, {
            version: intent.version,
            ...(kind === 'replied'
              ? { status: 'waiting' as const, draft: intent.draft }
              : {
                  status: 'completed' as const,
                  progress_notes: intent.progress_notes,
                }),
          });
          compatibility = true;
          result = {
            todo: legacy,
            actions: { replied: false, replied_at: null },
            reward: null,
          };
        }
        if (!guard.isCurrent()) return;
        confirmedIntents.current.delete(kind);
        onUpdate(result.todo);
        invalidate();
        setNotice(
          compatibility
            ? '已按兼容方式保存。当前服务不支持成长动作记录，更新后端后可使用。'
            : message,
        );
        if (!compatibility) void growth?.confirmReward(observation);
      } catch (failure) {
        if (
          guard.isCurrent() &&
          failure instanceof ApiError &&
          [400, 409, 410, 422].includes(failure.status)
        )
          confirmedIntents.current.delete(kind);
        throw failure;
      }
    });
  const prepare = () =>
    action.run(async guard => {
      growth?.prepareReward(todo.id);
      if (!prepareId.current) prepareId.current = newRequestId();
      const updated = await prepareTodo(api, todo.id, prepareId.current);
      if (!guard.isCurrent()) return;
      onUpdate(updated);
      invalidate();
      setTask(undefined);
      setNotice(preparationPendingNotice);
      prepareId.current = '';
      refresh();
    });
  const viewTask = () =>
    action.run(async guard => {
      if (!todo.linked_task_id) return;
      const result = await api.task(todo.linked_task_id);
      if (guard.isCurrent()) {
        setTask(result);
        if (
          ['failed', 'cancelled', 'succeeded', 'uncertain'].includes(
            result.status,
          )
        ) {
          onPreparationStopped();
          setNotice(current =>
            current === preparationPendingNotice ? '' : current,
          );
        }
      }
    });
  const completeExercise = () =>
    confirmedAction(
      'exercise_completed',
      () => {
        const duration = validateMinutes(minutes);
        return {
          actual_minutes: duration,
          progress_notes: [
            notesValue.current.trim(),
            duration
              ? `实际运动 ${duration} 分钟（自行记录）`
              : '已自行确认这次运动完成',
          ]
            .filter(Boolean)
            .join('\n'),
        };
      },
      '已记录这次运动完成。',
    );
  const share = () =>
    action.run(async guard => {
      if (!draft.trim()) throw new Error('先写好回复草稿。');
      if (draft !== todo.draft) {
        const updated = await updateTodo(api, todo.id, {
          version: todo.version,
          draft,
        });
        if (!guard.isCurrent()) return;
        onUpdate(updated);
        invalidate();
      }
      await platform.share(draft, todo.title);
      if (guard.isCurrent())
        setNotice('已打开系统分享。实际回复后，再确认进入等待。');
    });
  const terminal = todo.status === 'completed' || todo.status === 'dismissed';
  const preparationStopped = Boolean(
    task &&
      ['succeeded', 'failed', 'cancelled', 'uncertain'].includes(task.status),
  );
  return (
    <View style={s.gap}>
      <Text style={s.title}>{todo.title}</Text>
      <Text style={s.small}>
        {todoKinds[todo.kind]} · {todo.source_label || '你添加'}
        {todo.due_at ? ' · ' + formatDate(todo.due_at) : ''}
        {todo.estimated_minutes ? ` · 预计 ${todo.estimated_minutes} 分钟` : ''}
      </Text>
      {!!todo.description && <Text style={s.body}>{todo.description}</Text>}
      {todo.source_kind === 'growth_journey' && !terminal && <GrowthFocusTimer todoId={todo.id} minutes={todo.estimated_minutes} />}
      <ErrorNotice message={action.error} retry={refresh} />
      {!!notice && <Notice>{notice}</Notice>}
      {todo.kind === 'communication' && (
        <>
          {replyRecord.value?.replied && (
            <>
              <Text style={s.small}>
                你已确认实际回复。回复记录与整件事的完成状态分别记录，可以单独纠正。
              </Text>
              <Button
                variant="ghost"
                loading={action.busy}
                onPress={() => {
                  void confirmedAction(
                    'undo_replied',
                    {},
                    '已撤销回复确认；已确认的事项完成记录会保留。',
                  );
                }}
              >
                撤销已回复记录
              </Button>
            </>
          )}
          {replyRecord.error && (
            <ErrorNotice
              message="回复确认记录暂时无法读取。可以重试，原有事项仍然保留。"
              retry={replyRecord.refresh}
            />
          )}
        </>
      )}
      {todo.status === 'suggested' ? (
        <>
          <Notice>这是从所选资料发现的候选事项，请确认后加入。</Notice>
          <Button
            loading={action.busy}
            onPress={() => {
              void save({ status: 'pending' }, '已加入待处理事项。');
            }}
          >
            确认加入
          </Button>
          <Button
            variant="secondary"
            disabled={action.busy}
            onPress={() => setEditing(!editing)}
          >
            修改后再确认
          </Button>
          <Button
            variant="ghost"
            loading={action.busy}
            onPress={() => {
              void save({ status: 'dismissed' }, '已忽略这条发现。');
            }}
          >
            忽略这条
          </Button>
        </>
      ) : terminal ? (
        <>
          <Notice>
            {todo.status === 'completed'
              ? '你已确认这件事完成。'
              : '这条发现已忽略。'}
          </Notice>
          <Button
            variant="secondary"
            loading={action.busy}
            onPress={() => {
              void save({ status: 'pending' }, '已恢复为待处理。');
            }}
          >
            恢复为待处理
          </Button>
        </>
      ) : todo.status === 'waiting' ? (
        <>
          <Notice>正在等待后续进展。你可以记录新消息，再决定是否结束。</Notice>
          <Button
            variant="secondary"
            loading={action.busy}
            onPress={() => {
              void save({ status: 'pending' }, '已恢复为待处理。');
            }}
          >
            继续处理
          </Button>
          <Button
            loading={action.busy}
            onPress={() => {
              void save({ status: 'completed' }, '已按你的确认记录完成。');
            }}
          >
            我已确认这件事结束
          </Button>
        </>
      ) : todo.kind === 'exercise' ? (
        <>
          {todo.status === 'in_progress' ? (
            <>
              <Field
                label="实际运动分钟数（可选）"
                keyboardType="number-pad"
                maxLength={4}
                value={minutes}
                onChangeText={setMinutes}
              />
              <Button
                loading={action.busy}
                onPress={() => {
                  void completeExercise();
                }}
              >
                我已完成这次运动
              </Button>
            </>
          ) : (
            <Button
              loading={action.busy}
              onPress={() => {
                void save(
                  { status: 'in_progress' },
                  '已开始，结束时由你确认。',
                );
              }}
            >
              开始这次运动
            </Button>
          )}
          <Text style={s.small}>按实际情况自行记录。</Text>
        </>
      ) : (
        <>
          {(
            ['communication', 'learning', 'reading', 'expense'] as string[]
          ).includes(todo.kind) && (
            <>
              {!todo.draft && !todo.linked_task_id && (
                <Button
                  loading={action.busy}
                  onPress={() => {
                    void prepare();
                  }}
                >
                  {
                    (
                      {
                        communication: '准备回复草稿',
                        learning: '准备讲解与练习',
                        reading: '整理阅读重点',
                        expense: '整理材料清单',
                      } as Record<string, string>
                    )[todo.kind]
                  }
                </Button>
              )}
              <Text style={s.small}>
                {todo.kind === 'learning'
                  ? '按你的目标和实际进度准备讲解、练习和笔记；学完后由你确认。'
                  : todo.kind === 'expense'
                  ? '先整理材料与缺项，实际提交和处理结果由你记录。'
                  : '准备好的内容可继续修改。'}
              </Text>
            </>
          )}
          <Button
            variant="secondary"
            loading={action.busy}
            onPress={() => {
              void save({ status: 'completed' }, '已按你的确认记录完成。');
            }}
          >
            {todo.kind === 'learning'
              ? '我已完成这次学习'
              : todo.kind === 'reading'
              ? '我已读完'
              : todo.kind === 'errand'
              ? '这件事我已办好'
              : todo.kind === 'communication'
              ? '我已确认本轮沟通结束'
              : todo.kind === 'expense'
              ? '我已确认报销处理结束'
              : '这件事我已完成'}
          </Button>
          {todo.kind === 'communication' && (
            <Button
              variant="secondary"
              loading={action.busy}
              onPress={() => {
                void confirmedAction(
                  'replied',
                  { draft: draftValue.current || null },
                  '已按你的确认记录为等待后续。',
                );
              }}
            >
              我已实际回复 → 等待
            </Button>
          )}
          {todo.kind === 'expense' && (
            <Button
              variant="secondary"
              loading={action.busy}
              onPress={() => {
                void save(
                  { status: 'waiting' },
                  '已记录你实际提交，等待处理。',
                );
              }}
            >
              我已实际提交 → 等待
            </Button>
          )}
        </>
      )}
      {todo.linked_task_id && (
        <>
          {!todo.draft && !terminal && (
            <Text style={s.small}>
              {preparationStopped
                ? '尚无可用的准备内容。你可以重新准备，已记录的进度会保留。'
                : pollPaused
                ? '准备结果还未确认。可以刷新或查看准备进展。'
                : '准备结果尚未确认，正在定时更新。'}
            </Text>
          )}
          {!todo.draft &&
            !terminal &&
            todo.status !== 'suggested' &&
            preparationStopped && (
              <Button
                loading={action.busy}
                onPress={() => {
                  void prepare();
                }}
              >
                重新准备内容
              </Button>
            )}
          <Button
            variant="ghost"
            loading={action.busy}
            onPress={() => {
              void viewTask();
            }}
          >
            查看准备进展
          </Button>
          {task && (
            <View style={s.paper}>
              <Text style={s.body}>{taskStatuses[task.status]}</Text>
              {!!(task.error || task.summary || task.result) && (
                <Text style={s.small} selectable>
                  {task.error || task.summary || task.result}
                </Text>
              )}
              <Pressable
                accessibilityRole="button"
                onPress={() => navigate({ name: 'task', id: task.id })}
              >
                <Text style={s.link}>查看助手执行记录 →</Text>
              </Pressable>
            </View>
          )}
          <Button variant="ghost" onPress={refresh}>
            刷新事项
          </Button>
        </>
      )}
      {(todo.draft || draft) && (
        <>
          <Text style={s.section}>
            {todo.kind === 'communication' ? '回复草稿' : '准备的内容'}
          </Text>
          <View style={s.paper}>
            <Text style={s.body} selectable>
              {draft}
            </Text>
          </View>
          <Text style={s.small}>
            长按内容可复制{todo.kind === 'communication' ? '回复' : ''}。
          </Text>
          {!terminal && (
            <>
              <Field
                label={
                  todo.kind === 'communication'
                    ? '修改回复草稿'
                    : '修改准备的内容'
                }
                multiline
                value={draft}
                onChangeText={changeDraft}
                maxLength={24000}
              />
              <Button
                variant="secondary"
                loading={action.busy}
                onPress={() => {
                  void save({ draft: draft.trim() || null }, '内容已保存。');
                }}
              >
                保存内容
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            loading={action.busy}
            onPress={() => {
              void share();
            }}
          >
            {todo.kind === 'communication' ? '分享回复' : '分享内容'}
          </Button>
        </>
      )}
      {!terminal && (
        <>
          <Text style={s.section}>
            {todo.kind === 'learning' ? '学习进度与笔记' : '记下进展'}
          </Text>
          <Field
            label="进展记录"
            value={notes}
            onChangeText={changeNotes}
            multiline
            maxLength={12000}
            placeholder={
              todo.kind === 'learning'
                ? '练习结果、还不明白的地方、下次从哪里继续…'
                : '实际做了什么，接下来还需什么…'
            }
          />
          <Button
            variant="secondary"
            loading={action.busy}
            onPress={() => {
              void save(
                { progress_notes: notes.trim() || null },
                '进展已保存。',
              );
            }}
          >
            保存进展
          </Button>
        </>
      )}
      {terminal && !!todo.progress_notes && (
        <Text style={s.body} selectable>
          {todo.progress_notes}
        </Text>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: sourceOpen }}
        onPress={() => setSourceOpen(!sourceOpen)}
      >
        <Text style={s.link}>
          {sourceOpen ? '收起来源与原文' : '看看来源与原文'}
        </Text>
      </Pressable>
      {sourceOpen && (
        <View style={s.paper}>
          <Text style={s.small}>
            {todo.source_label || '你添加'} · {formatDate(todo.created_at)}
          </Text>
          <Text style={s.body} selectable>
            {todo.source_excerpt || '这件事由你自行记录。'}
          </Text>
          {todo.source_kind === 'conversation' && todo.source_id && (
            <Button
              variant="ghost"
              onPress={() =>
                navigate({ name: 'chat', conversationId: todo.source_id! })
              }
            >
              打开原对话
            </Button>
          )}
          {todo.source_kind === 'integration_import' && (
            <Button
              variant="ghost"
              onPress={() => navigate({ name: 'integrations' })}
            >
              查看已导入的资料
            </Button>
          )}
        </View>
      )}
      {!terminal && (
        <Button variant="ghost" onPress={() => setEditing(!editing)}>
          {editing ? '收起修改' : '修改事项'}
        </Button>
      )}
      {editing && (
        <TodoEditor
          key={todo.id}
          todo={todo}
          timezone={user?.timezone ?? 'Asia/Shanghai'}
          busy={action.busy}
          onSave={input => {
            void save(
              {
                ...input,
                ...(todo.status === 'suggested'
                  ? { status: 'pending' as const }
                  : {}),
              },
              todo.status === 'suggested'
                ? '已按修改加入事项。'
                : '修改已保存。',
            );
          }}
        />
      )}
    </View>
  );
}
