import type { GrowthJourney, JourneyStep } from './types';

/** Keep the goal and completion criterion stable while adapting the way to start. */
export function coachingPrompt(
  journey: GrowthJourney,
  step: JourneyStep,
  easier = false,
  alternative = false,
) {
  const position = journey.steps.findIndex(value => value.id === step.id);
  const previous = journey.steps
    .slice(0, Math.max(0, position))
    .reverse()
    .find(value => value.difficulty);
  const difficulty = step.difficulty ?? previous?.difficulty;
  const method = alternative
    ? '请围绕同一个完成标准换一种练习做法，先给我“看一个例子／自己动手试／边问边学”三个简短选项，等我选后再继续，不另建重复待办。'
    : easier || difficulty === 'too_hard'
    ? '我明确反馈过有点难，请先拆成一个5分钟能开始的小练习，先问一个简单问题，别一次布置很多任务。'
    : difficulty === 'too_easy'
    ? `我反馈过之前太简单，请先用一个小问题确认基础，再在约${step.estimated_minutes}分钟内给一点有实际输出的挑战，不直接跳过后续步骤。`
    : `请陪我用约${step.estimated_minutes}分钟开始这一步，一次引导一个小动作，先给第一个动作，等待我的反馈。`;
  return `我正在推进自己的成长目标：${journey.goal}。当前这一步：${step.title}。完成标准：${step.criterion}。${method}不要替我勾选完成，也不要在没有练习证据时说我已经掌握。`;
}
