import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '../../ui/Text';
import { Button, Field } from '../../ui/components';
import type { CreateTodo, Todo, TodoKind } from './types';
import { localDue, parseDue, todoKinds, validateMinutes } from './model';
import { todoStyles as s } from './ui';

export function TodoEditor({
  todo,
  initialTitle = '',
  timezone,
  busy,
  onSave,
  onEdit,
}: {
  todo?: Todo;
  initialTitle?: string;
  timezone: string;
  busy: boolean;
  onSave: (value: CreateTodo) => void;
  onEdit?: () => void;
}) {
  const [title, setTitle] = useState(todo?.title ?? initialTitle);
  const [description, setDescription] = useState(todo?.description ?? '');
  const [kind, setKind] = useState<TodoKind>(todo?.kind ?? 'general');
  const [due, setDue] = useState(() => localDue(todo?.due_at, timezone));
  const [minutes, setMinutes] = useState(
    todo?.estimated_minutes?.toString() ?? '',
  );
  const [error, setError] = useState('');
  const save = () => {
    try {
      if (!title.trim()) throw new Error('先写下要做的一件事。');
      const value = {
        title: title.trim(),
        description: description.trim(),
        kind,
        due_at: parseDue(due, timezone),
        estimated_minutes: validateMinutes(minutes),
      };
      setError('');
      onSave(value);
    } catch (failure) {
      setError((failure as Error).message);
    }
  };
  return (
    <View style={s.gap}>
      <Field
        label="事项名称"
        value={title}
        onChangeText={value => {
          onEdit?.();
          setTitle(value);
        }}
        maxLength={200}
      />
      <Field
        label="补充说明"
        value={description}
        onChangeText={value => {
          onEdit?.();
          setDescription(value);
        }}
        multiline
        maxLength={8000}
      />
      <View style={s.chips}>
        {(Object.entries(todoKinds) as [TodoKind, string][]).map(
          ([id, label]) => (
            <Pressable
              key={id}
              accessibilityRole="radio"
              accessibilityState={{ checked: kind === id }}
              onPress={() => {
                if (kind !== id) onEdit?.();
                setKind(id);
              }}
              style={[s.chip, kind === id && s.chipSelected]}
            >
              <Text style={kind === id ? s.link : s.small}>{label}</Text>
            </Pressable>
          ),
        )}
      </View>
      <Field
        label="计划时间（可选）"
        placeholder="2026-10-29 19:00"
        value={due}
        onChangeText={value => {
          onEdit?.();
          setDue(value);
        }}
        autoCapitalize="none"
      />
      <Text style={s.small}>
        按你的时区 {timezone} 记录；留空表示暂不定时间。
      </Text>
      <Field
        label="预计分钟数（可选）"
        value={minutes}
        onChangeText={value => {
          onEdit?.();
          setMinutes(value);
        }}
        keyboardType="number-pad"
        maxLength={3}
      />
      {!!error && (
        <Text accessibilityRole="alert" style={s.body}>
          {error}
        </Text>
      )}
      <Button onPress={save} loading={busy}>
        {todo ? '保存修改' : '加入事项'}
      </Button>
    </View>
  );
}
