import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useAction, useApp } from '../../app/context';
import { platform } from '../../platform/ports';
import { Text } from '../../ui/Text';
import { Button, Card, ErrorNotice, Notice } from '../../ui/components';
import { Icon } from '../../ui/visuals';
import { colors, styles as s } from '../../ui/theme';
import { version } from '../../../package.json';

const questions = [
  {
    title: '如何连接自己的邮箱？',
    body: '在“应用连接”中选择 QQ 邮箱或网易邮箱，按引导开启 IMAP / SMTP，填写完整邮箱地址和客户端授权码。授权码不是邮箱登录密码；验证通过后才会保存。',
  },
  {
    title: '数据保存在哪里？',
    body: '默认使用官方服务，也可以在“服务连接”中选择自己的服务器。两边的账号和数据独立，切换不会自动搬迁资料。使用外部模型时，对应内容会交给所配置的服务商处理。',
  },
  {
    title: '任务从哪里来？',
    body: '你可以手动添加，也可以从对话和已导入的资料中发现待办，再确认加入任务。手机短信、日历与其他资料需要逐项授权，未授权的内容不会用于整理。',
  },
  {
    title: '手机资料为什么需要确认？',
    body: '应用通知与系统分享的内容先进入待接收列表。只有确认导入的内容才保存到当前服务器。对话、资料与长期记忆可以分别管理和删除。',
  },
];
export function HelpScreen() {
  const { navigate } = useApp();
  const [expanded, setExpanded] = useState<string | null>(questions[0].title);
  const [copied, setCopied] = useState(false);
  const action = useAction();
  return (
    <ScrollView
      contentContainerStyle={s.content}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={s.title}>帮助与反馈</Text>
      <Text style={s.subtitle}>遇到问题，先从这里找答案。</Text>
      <ErrorNotice message={action.error} />
      <View style={v.questions}>
        {questions.map(question => (
          <View key={question.title} style={v.question}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={question.title}
              accessibilityState={{ expanded: expanded === question.title }}
              onPress={() =>
                setExpanded(old =>
                  old === question.title ? null : question.title,
                )
              }
              style={v.questionHeader}
            >
              <Text style={v.questionTitle}>{question.title}</Text>
              <Icon name="chevronDown" size={17} color={colors.secondary} />
            </Pressable>
            {expanded === question.title ? (
              <Text selectable style={v.answer}>
                {question.body}
              </Text>
            ) : null}
          </View>
        ))}
      </View>
      <Button
        variant="secondary"
        onPress={() => navigate({ name: 'integrations' })}
      >
        打开应用连接
      </Button>
      <Button
        variant="ghost"
        onPress={() => navigate({ name: 'settings', section: 'server' })}
      >
        检查服务连接
      </Button>
      <Card style={v.feedback}>
        <Text style={s.cardTitle}>把问题告诉我们</Text>
        <Text style={v.answer}>
          记录你做了什么、原本期待看到什么，以及实际发生的情况。截图前请遮住手机号、邮箱和私人内容。
        </Text>
        <Button
          variant="secondary"
          loading={action.busy}
          onPress={() => {
            void action.run(async ({ isCurrent }) => {
              await platform.copyText(
                `妥啦问题反馈\n版本：${version}\n手机型号与系统：\n操作步骤：\n期望结果：\n实际结果：`,
              );
              if (isCurrent()) setCopied(true);
            });
          }}
        >
          复制反馈模板
        </Button>
        {copied ? <Notice>模板已复制，补充后可发给维护者。</Notice> : null}
      </Card>
      <Text style={v.version}>妥啦 · v{version}</Text>
    </ScrollView>
  );
}
const v = StyleSheet.create({
  questions: {
    marginTop: 24,
    marginBottom: 20,
    backgroundColor: '#FCFCFE',
    borderRadius: 22,
    paddingHorizontal: 18,
  },
  question: {
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E9ECF2',
  },
  questionHeader: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  questionTitle: {
    flex: 1,
    color: colors.ink,
    fontSize: 14,
    fontWeight: '500',
  },
  answer: {
    color: colors.secondary,
    fontSize: 13,
    lineHeight: 23,
    paddingVertical: 9,
  },
  feedback: { marginTop: 24 },
  version: {
    fontSize: 12,
    color: colors.secondary,
    textAlign: 'center',
    marginVertical: 22,
  },
});
