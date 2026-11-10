import type { Conversation, Message } from '../../domain/types';

export type RecentContext = Conversation & { excerpts: string[]; preview: Message[] };
export type ContinuationCandidate = { conversation: RecentContext; reason: string; score: number };

/** Conservative continuation intent, rather than a recommendation for every shared topic. */
export function needsPreviousContext(draft: string): boolean {
  if (draft.trim().length < 6 || draft.length > 4000 || /新问题|新话题|重新开始|不要参考|不用参考|别接着|不接着|另起/.test(draft)) return false;
  return /上次|之前|上一版|接着|继续|这份|这版|这段|那个|再把|(?:计划|安排).{0,10}(?:调整|修改)|(?:调整|修改).{0,10}(?:计划|安排)|(?:回复|方案).{0,10}(?:改|简洁)/.test(draft);
}

const generic = new Set(['今天','明天','昨天','这次','之前','上次','继续','安排','计划','学习','回复','一下','帮我','怎么','修改','调整','时间','内容','什么','可以','还有']);
const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, ' ');
function terms(draft: string): Map<string, number> {
  const result = new Map<string, number>();
  const cleaned = normalize(draft.replace(/学习计划|学习安排|之前的|上次的|这个计划|这份计划|原来的|给我的|那个方案|这段对话|上次|之前|上一版|接着|继续|那个|这份|这版|这段/g, ' '));
  for (const word of cleaned.match(/[a-z][a-z0-9]{1,23}/g) ?? []) {
    if (!['what','how','the','and','please','this','that','with'].includes(word)) result.set(word, 5.2);
  }
  for (const segment of cleaned.match(/[\u3400-\u9fff]+/g) ?? []) {
    for (const size of [2,3,4]) for (let at=0;at+size<=segment.length;at++) {
      const term = segment.slice(at,at+size);
      if (/[的了吗呢吧]/.test(term)) continue;
      result.set(term, generic.has(term) ? 0.3 : size === 2 ? 1.1 : size === 3 ? 1.35 : 1.5);
    }
  }
  return result;
}

export function findContinuation(draft: string, recent: readonly RecentContext[]): ContinuationCandidate | null {
  if (!needsPreviousContext(draft)) return null;
  const query = new Map([...terms(draft.slice(0,480))].sort((a,b)=>b[1]-a[1]).slice(0,100));
  const docs = recent.slice(0,20).map(conversation => ({ conversation,
    title: normalize(conversation.title), body: normalize(conversation.excerpts.join(' ')) }));
  const frequency=new Map([...query.keys()].map(term=>[term,docs.filter(value=>value.title.includes(term)||value.body.includes(term)).length]));
  const scored = docs.map(doc => {
    let score=0,distinctive=0,titleHits=0,totalHits=0,englishHits=0;
    for (const [term,weight] of query) {
      const inTitle=doc.title.includes(term),inBody=doc.body.includes(term);
      if (!inTitle && !inBody) continue;
      const idf=1+Math.log((docs.length+1)/((frequency.get(term)??0)+1));
      score+=weight*idf*(inTitle?1.3:0.8);totalHits++;
      if(weight>=1.1)distinctive++;
      if(inTitle&&weight>=1.1)titleHits++;
      if(inTitle&&/^[a-z]/.test(term))englishHits++;
    }
    return { ...doc, score, distinctive, titleHits,totalHits,englishHits };
  }).filter(value=>value.score>=6 && (value.distinctive>=2 || value.titleHits>=1&&value.totalHits>=2 || value.englishHits>0 || value.score>=9)
    || /上次|之前|上一版/.test(draft)&&value.score>=2.4&&value.titleHits>=1&&value.distinctive>=1)
    .sort((a,b)=>b.score-a.score);
  const best=scored[0],second=scored[1];
  if(!best || second&&(second.score>=best.score*.78 || best.score-second.score<2.5)) return null;
  const evidence=best.conversation.excerpts.find(text=>[...query.keys()].some(term=>normalize(text).includes(term)));
  return { conversation:best.conversation,score:best.score,
    reason:evidence ? `之前聊到：${evidence.replace(/\s+/g,' ').slice(0,72)}` : '这段对话的主题与你当前想继续的内容相关。' };
}
