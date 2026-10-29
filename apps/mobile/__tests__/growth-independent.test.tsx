/** Independent interaction tests. Mock transport is not evidence of server persistence. */
import React from 'react';
import { Text, TextInput } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { AppContextValue, AppProvider } from '../src/app/context';
import { Button, ErrorNotice } from '../src/ui/components';
import { platform } from '../src/platform/ports';
import { GrowthProvider, GrowthFeedbackBanner, useGrowthData } from '../src/features/growth/context';
import { DailyRecommendations, GrowthEntry, useDailyGrowth } from '../src/features/growth/DailyGrowth';
import { GrowthSettingsScreen } from '../src/features/growth/GrowthSettings';
import { TodoDetail } from '../src/features/todos/TodoDetail';
import type { DailyPlan, DailyPlanItem, GrowthPreferences, GrowthSummary, TodoReward } from '../src/features/growth/types';
import type { Todo } from '../src/features/todos/types';

jest.mock('../src/platform/ports', () => ({ platform: { share: jest.fn().mockResolvedValue(undefined), onForeground: jest.fn(() => () => {}) } }));
jest.mock('../src/ui/visuals', () => ({ Icon: () => null, AssistantOrb: () => null }));
jest.mock('../src/features/growth/GrowthOrb', () => ({ GrowthOrb: () => null }));
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => jest.clearAllMocks());
function deferred<T>() { let resolve!: (value:T)=>void; let reject!: (error:unknown)=>void;const promise=new Promise<T>((res,rej)=>{resolve=res;reject=rej;});return {promise,resolve,reject}; }
const todo=(id:string,extra:Partial<Todo>={}):Todo=>({id,title:'真实事项'+id,description:'用户保存的内容',kind:'general',status:'pending',source_kind:'manual',source_label:'手动添加',created_at:'2026-10-30T00:00:00Z',updated_at:'2026-10-30T00:00:00Z',version:1,...extra});
const preferences=(extra:Partial<GrowthPreferences>={}):GrowthPreferences=>({enabled:true,daily_minutes:15,use_existing_todos:true,goals:[],paused_today:false,timezone:'Pacific/Kiritimati',version:1,halo:'classic',...extra});
const summary=(extra:Partial<GrowthSummary>={}):GrowthSummary=>({total_xp:0,level:1,level_xp:0,xp_per_level:60,halo:'classic',available_halos:['classic'],today:{date:'2026-10-30',timezone:'Pacific/Kiritimati',action_count:0,xp:0,paused:false},week:{start_date:'2026-10-26',end_date:'2026-11-01',active_days:0,days:[],communication_actions:0,learning_actions:0,exercise_minutes:0,records:[]},milestones:[],...extra});
const item=(id:string,extra:Partial<DailyPlanItem>={}):DailyPlanItem=>({id,title:'建议'+id,description:'只做一小步',kind:'learning',reason:'所选目标',estimated_minutes:5,source_kind:'ai_daily',source_label:'AI 每日建议',todo_id:null,todo:null,status:'suggested',focus:false,can_replace:true,version:1,...extra});
const plan=(extra:Partial<DailyPlan>={}):DailyPlan=>({id:'plan-one',local_date:'2026-10-30',timezone:'Pacific/Kiritimati',status:'ready',error:null,items:[],can_retry:false,...extra});
function childText(value:any):string {return Array.isArray(value)?value.map(childText).join(''):typeof value==='string'||typeof value==='number'?String(value):React.isValidElement(value)?childText((value.props as any).children):'';}
const texts=(tree:ReactTestRenderer)=>tree.root.findAllByType(Text).map(n=>childText(n.props.children)).join('\n');
const errors=(tree:ReactTestRenderer)=>tree.root.findAllByType(ErrorNotice).map(n=>n.props.message).filter(Boolean).join(' ');
function transport() {
  const state={preferences:preferences(),summary:summary(),plan:plan(),reward:{reward:null,total_xp:0,level:1} as TodoReward};
  const extra=jest.fn<Promise<any>,[string,string,any]>(async(path)=>{throw new Error('Unexpected fixture path '+path);});
  const request=jest.fn(async(path:string,method='GET',body?:any)=>{
    if(path==='/growth/preferences'&&method==='GET')return state.preferences;
    if(path==='/growth/summary')return state.summary;
    if(path.startsWith('/growth/todos/'))return state.reward;
    if(path==='/daily-plan'&&method==='GET')return state.plan;
    return extra(path,method,body);
  });return {state,extra,request,baseUrl:'https://synthetic.fixture.invalid'};
}
function context(api:unknown,id='a',revision=0):AppContextValue {return {api,user:{id,name:id,timezone:'Pacific/Kiritimati'},preferences:{serverUrl:'https://synthetic.fixture.invalid'},revision,navigate:jest.fn(),back:jest.fn(),invalidate:jest.fn(),formatDate:(v:string)=>v} as unknown as AppContextValue;}
async function mount(api:unknown,page:React.ReactNode=null) {
  let tree!:ReactTestRenderer;let ctx=context(api);
  let growth!:NonNullable<ReturnType<typeof useGrowthData>>;let daily!:ReturnType<typeof useDailyGrowth>;
  function Probe(){growth=useGrowthData()!;daily=useDailyGrowth();return <><GrowthEntry/><GrowthFeedbackBanner/><DailyRecommendations daily={daily}/>{page}</>;}
  const render=()=> <AppProvider value={ctx}><GrowthProvider><Probe/></GrowthProvider></AppProvider>;
  await act(async()=>{tree=create(render());});
  return {tree,get growth(){return growth;},get daily(){return daily;},get ctx(){return ctx;},async owner(next:unknown,id:string){ctx=context(next,id);await act(async()=>tree.update(render()));},async revision(){ctx={...ctx,revision:ctx.revision+1};await act(async()=>tree.update(render()));},async close(){await act(async()=>tree.unmount());}};
}
async function press(tree:ReactTestRenderer,label:string) {const node=tree.root.findAllByType(Button).find(n=>childText(n.props.children)===label);expect(node).toBeDefined();await act(async()=>{node!.props.onPress();});}
async function input(tree:ReactTestRenderer,label:string,value:string) {const node=tree.root.findAllByType(TextInput).find(n=>n.props.accessibilityLabel===label);expect(node).toBeDefined();await act(async()=>node!.props.onChangeText(value));}
function reward(id:string,version=1):TodoReward {return {reward:{id:'receipt-'+id,todo_id:id,title:'实际行动',kind:'general',xp:10,active:true,version,earned_at:'2026-10-30T00:00:00Z',updated_at:'2026-10-30T00:00:00Z',local_date:'2026-10-30',timezone:'Pacific/Kiritimati',minutes:null},total_xp:10,level:1};}

it('new disabled account has no sample growth or plan generation, even on refresh',async()=>{
  const api=transport();api.state.preferences=preferences({enabled:false,version:0});const app=await mount(api);
  expect(texts(app.tree)).toContain('选择目标与时间后开启');expect(texts(app.tree)).not.toMatch(/Lv\.2|90|本周已行动/);
  await app.revision();expect(api.request.mock.calls.filter(([p])=>p.startsWith('/daily-plan'))).toHaveLength(0);expect(app.growth.feedback).toBeNull();await app.close();
});

it('reward feedback uses the owned receipt transition, deduplicates replay, and clears on undo',async()=>{
  const api=transport();const app=await mount(api);let observation:any;
  await act(async()=>app.growth.prefetchReward('mine'));
  await act(async()=>{observation=await app.growth.prepareReward('mine');});
  api.state.reward={reward:null,total_xp:100,level:2};api.state.summary=summary({total_xp:100,level:2});
  await act(async()=>app.growth.confirmReward(observation));expect(app.growth.feedback).toBeNull();
  api.state.reward=reward('mine');api.state.summary=summary({total_xp:10,level_xp:10,today:{...summary().today,action_count:1,xp:10}});
  await act(async()=>app.growth.confirmReward(observation));expect(texts(app.tree)).toContain('+10 成长');
  await act(async()=>app.growth.dismissFeedback());await act(async()=>app.growth.confirmReward(observation));expect(app.growth.feedback).toBeNull();
  let undo:any;await act(async()=>{undo=await app.growth.prepareReward('mine');});api.state.reward={...reward('mine',2),reward:{...reward('mine',2).reward!,active:false}};
  await act(async()=>app.growth.confirmReward(undo));expect(app.growth.feedback).toBeNull();await app.close();
});

it('late previous-account reads and reward acknowledgements cannot leak feedback or plans',async()=>{
  const api=transport(),other=transport();const delayed=deferred<TodoReward>(),latePlan=deferred<DailyPlan>();let reads=0;
  const oldRequest=api.request.getMockImplementation()!;
  api.request.mockImplementation((path,method='GET',body)=>path==='/daily-plan'?latePlan.promise:path.startsWith('/growth/todos/')&&++reads===2?delayed.promise:oldRequest(path,method,body));
  const app=await mount(api);await act(async()=>app.growth.prefetchReward('secret-a'));let observation:any;await act(async()=>{observation=await app.growth.prepareReward('secret-a');});
  let pending!:Promise<void>;await act(async()=>{pending=app.growth.confirmReward(observation);});
  await app.owner(other,'b');await act(async()=>{delayed.resolve(reward('secret-a'));latePlan.resolve(plan({items:[item('private-a',{title:'账号甲私有计划哨兵'})]}));});await pending;
  expect(app.growth.feedback).toBeNull();expect(texts(app.tree)).not.toContain('账号甲私有计划哨兵');expect(other.extra).not.toHaveBeenCalled();await app.close();
});

it('ensures one plan per owner/day and retains a lost-response retry intent',async()=>{
  const api=transport(),lost=deferred<DailyPlan>();api.state.plan=plan({id:null,status:'ready'});
  api.extra.mockImplementation((path)=>path==='/daily-plan/ensure'?lost.promise:Promise.reject(new Error(path)));
  const app=await mount(api);const posts=()=>api.request.mock.calls.filter(([p,m])=>p==='/daily-plan/ensure'&&m==='POST');
  expect(posts()).toHaveLength(1);const requestId=posts()[0][2].client_request_id;
  await app.revision();expect(posts()).toHaveLength(1);
  await act(async()=>lost.reject(new Error('response lost')));expect(errors(app.tree)).toContain('response lost');
  api.extra.mockResolvedValue(plan({status:'queued'}));await act(async()=>app.daily.ensure());
  expect(posts()).toHaveLength(2);expect(posts()[1][2].client_request_id).toBe(requestId);expect(app.growth.feedback).toBeNull();await app.close();
});

it('accept duplicate taps are guarded and retry reuses the admission key without reward',async()=>{
  const api=transport(),lost=deferred<any>();const candidate=item('learn');api.state.plan=plan({items:[candidate]});api.extra.mockReturnValue(lost.promise);
  const app=await mount(api);
  await act(async()=>{void app.daily.act(candidate,'accept');void app.daily.act(candidate,'accept');});
  const posts=()=>api.request.mock.calls.filter(([p,m])=>p.endsWith('/accept')&&m==='POST');expect(posts()).toHaveLength(1);
  const key=posts()[0][2].client_request_id;await act(async()=>lost.reject(new Error('lost admission response')));
  api.extra.mockResolvedValue({item:{...candidate,status:'accepted',todo_id:'admitted'},todo:todo('admitted')});
  await act(async()=>app.daily.act(candidate,'accept'));expect(posts()).toHaveLength(2);expect(posts()[1][2].client_request_id).toBe(key);
  expect(app.ctx.navigate).toHaveBeenCalledWith({name:'todo',id:'admitted'});expect(app.growth.feedback).toBeNull();await app.close();
});

it('rest hides unstarted suggestions while preserving accepted work and never silently retries failures',async()=>{
  const api=transport();api.state.preferences=preferences({paused_today:true});api.state.plan=plan({status:'paused',items:[item('new'),item('started',{status:'accepted',todo_id:'learn',todo:todo('learn',{kind:'learning',status:'in_progress',progress_notes:'真实笔记'})}),item('wait',{status:'accepted',todo_id:'mail',todo:todo('mail',{status:'waiting'})})]});
  const app=await mount(api);expect(texts(app.tree)).toContain('建议started');expect(texts(app.tree)).not.toContain('建议new');expect(texts(app.tree)).not.toContain('建议wait');expect(texts(app.tree)).toContain('原有事项会保留');
  expect(api.extra).not.toHaveBeenCalled();api.state.preferences=preferences();api.state.plan=plan({status:'failed',error:'synthetic model unavailable',can_retry:true});await app.revision();
  expect(texts(app.tree)).toContain('synthetic model unavailable');expect(api.extra).not.toHaveBeenCalled();await app.close();
});

it('share only opens the user sheet; explicit replied sends a typed fact with draft and version',async()=>{
  const api=transport();let saved=todo('mail',{kind:'communication',draft:'用户自己的草稿'});let replied=false;
  api.extra.mockImplementation(async(path,method,body)=>{
    if(path==='/todos/mail/actions'&&method==='GET')return {replied,replied_at:null};
    if(path==='/todos/mail/actions'&&method==='POST'){expect(body.kind).toBe('replied');expect(body.version).toBe(saved.version);saved={...saved,status:'waiting',draft:body.draft,version:saved.version+1};replied=true;api.state.reward=reward('mail');api.state.summary=summary({total_xp:10,today:{...summary().today,action_count:1,xp:10}});return {todo:saved,actions:{replied:true,replied_at:'2026-10-30T00:00:00Z'},reward:api.state.reward.reward};}
    if(path==='/todos/mail')return saved;throw new Error(path);
  });const app=await mount(api,<TodoDetail id="mail"/>);
  await press(app.tree,'分享回复');expect(platform.share).toHaveBeenCalledWith('用户自己的草稿','真实事项mail');expect(saved.status).toBe('pending');expect(app.growth.feedback).toBeNull();expect(api.request.mock.calls.filter(([,m])=>m==='POST')).toHaveLength(0);
  await input(app.tree,'修改回复草稿','实际回复后的修订稿');await press(app.tree,'我已实际回复 → 等待');
  expect(saved.status).toBe('waiting');expect(saved.draft).toBe('实际回复后的修订稿');expect(texts(app.tree)).toContain('+10 成长');expect(texts(app.tree)).not.toMatch(/已自动发送|已发出邮件/);await app.close();
});

it('enabled settings validate raw minutes and explicitly disclose goals, stored sources and configured AI',async()=>{
  const api=transport();const app=await mount(api,<GrowthSettingsScreen/>);
  for(const value of ['0','121','1000','2.5']){await input(app.tree,'每日分钟数（5–120）',value);await press(app.tree,'保存我的节奏');expect(errors(app.tree)).toContain('5–120');}
  expect(api.request.mock.calls.filter(([,m])=>m==='PATCH')).toHaveLength(0);expect(texts(app.tree)).toContain('当前账号已保存的待办');expect(texts(app.tree)).toContain('当前服务配置的 AI');await app.close();
});

it('an older completion summary cannot celebrate or restore XP after the same Todo was undone',async()=>{
  const api=transport(),lateSummary=deferred<GrowthSummary>();const app=await mount(api);
  await act(async()=>app.growth.prefetchReward('same'));
  let completed:any;await act(async()=>{completed=app.growth.prepareReward('same');});
  api.state.reward=reward('same');
  let waitForOldSummary=true;
  const originalRequest=api.request.getMockImplementation()!;
  api.request.mockImplementation((path,method='GET',body)=>{
    if(path==='/growth/summary'&&waitForOldSummary){waitForOldSummary=false;return lateSummary.promise;}
    return originalRequest(path,method,body);
  });
  let oldConfirm!:Promise<void>;await act(async()=>{oldConfirm=app.growth.confirmReward(completed);});
  expect(waitForOldSummary).toBe(false);
  let undone:any;await act(async()=>{undone=app.growth.prepareReward('same');});
  api.state.reward={...reward('same',2),reward:{...reward('same',2).reward!,active:false},total_xp:0};
  api.state.summary=summary();await act(async()=>app.growth.confirmReward(undone));
  await act(async()=>lateSummary.resolve(summary({total_xp:10,level_xp:10,today:{...summary().today,action_count:1,xp:10}})));await oldConfirm;
  expect(app.growth.feedback).toBeNull();expect(texts(app.tree)).not.toContain('+10 成长');expect(app.growth.data?.summary.total_xp).toBe(0);await app.close();
});

it('a hanging growth reward GET never blocks the users ordinary Todo completion',async()=>{
  const api=transport(),hung=deferred<TodoReward>();let saved=todo('normal');
  const originalRequest=api.request.getMockImplementation()!;
  api.request.mockImplementation((path,method='GET',body)=>path.startsWith('/growth/todos/')?hung.promise:originalRequest(path,method,body));
  api.extra.mockImplementation(async(path,method,body)=>{
    if(path==='/todos/normal'&&method==='PATCH'){saved={...saved,...body,version:saved.version+1};return saved;}
    if(path==='/todos/normal')return saved;throw new Error(path);
  });
  const app=await mount(api,<TodoDetail id="normal"/>);
  await press(app.tree,'这件事我已完成');
  expect(api.request.mock.calls.some(([path,method])=>path==='/todos/normal'&&method==='PATCH')).toBe(true);
  expect(saved.status).toBe('completed');expect(texts(app.tree)).toContain('你已确认这件事完成');expect(app.growth.feedback).toBeNull();
  await app.close();await act(async()=>hung.resolve({reward:null,total_xp:0,level:1}));
});
