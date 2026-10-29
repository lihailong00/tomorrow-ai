import React from 'react';
import { Text, TextInput } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { AppContextValue, AppProvider } from '../src/app/context';
import { Button, ErrorNotice } from '../src/ui/components';
import { platform } from '../src/platform/ports';
import { TodoDetail } from '../src/features/todos/TodoDetail';
import { TodosScreen } from '../src/features/todos/TodosScreen';
import { useTodoList } from '../src/features/todos/useTodoList';
import type { Todo } from '../src/features/todos/types';

jest.mock('../src/platform/ports', () => ({ platform: { share: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../src/ui/visuals', () => ({ Icon: () => null, AssistantOrb: () => null }));
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => jest.clearAllMocks());
function deferred<T>() { let resolve!: (value:T)=>void; let reject!: (error:unknown)=>void;const promise=new Promise<T>((res,rej)=>{resolve=res;reject=rej;});return {promise,resolve,reject}; }
const todo=(id:string,extra:Partial<Todo>={}):Todo=>({id,title:'事项'+id,description:'用户实际记录的目标',kind:'general',status:'pending',source_kind:'manual',source_label:'手动添加',created_at:'2026-10-29T00:00:00Z',updated_at:'2026-10-29T00:00:00Z',version:1,...extra});
function childText(value:any):string {return Array.isArray(value)?value.map(childText).join(''):typeof value==='string'||typeof value==='number'?String(value):React.isValidElement(value)?childText((value.props as any).children):'';}
const texts=(tree:ReactTestRenderer)=>tree.root.findAllByType(Text).map(n=>childText(n.props.children)).join('\n');
const errors=(tree:ReactTestRenderer)=>tree.root.findAllByType(ErrorNotice).map(n=>n.props.message).filter(Boolean);
const query=(path:string):Record<string,string>=>Object.fromEntries((path.split('?')[1]??'').split('&').filter(Boolean).map(pair=>{const [key,value='']=pair.split('=');return [decodeURIComponent(key),decodeURIComponent(value)];}));
function context(api:unknown,userId='account-a'):AppContextValue {return {api,user:{id:userId,name:userId,timezone:'Asia/Shanghai'},preferences:{serverUrl:'https://fixture.invalid'},revision:0,navigate:jest.fn(),back:jest.fn(),invalidate:jest.fn(),formatDate:(value:string)=>value} as unknown as AppContextValue;}
async function mount(page:React.ReactNode,api:unknown,userId='account-a') {
  let tree!:ReactTestRenderer;let ctx=context(api,userId);
  const render=()=> <AppProvider value={ctx}>{page}</AppProvider>;
  await act(async()=>{tree=create(render());});
  return {tree,get ctx(){return ctx;},async owner(next:unknown,id:string){ctx=context(next,id);await act(async()=>tree.update(render()));},async close(){await act(async()=>tree.unmount());}};
}
async function press(tree:ReactTestRenderer,label:string) {
  const button=tree.root.findAllByType(Button).find(n=>childText(n.props.children)===label);
  expect(button).toBeDefined();await act(async()=>{button!.props.onPress();});
}
async function input(tree:ReactTestRenderer,label:string,value:string) {const node=tree.root.findAllByType(TextInput).find(n=>n.props.accessibilityLabel===label);expect(node).toBeDefined();await act(async()=>node!.props.onChangeText(value));}
function storedApi(value:Todo) {
  let saved=value;
  let replied=false;
  const detailPath='/todos/'+encodeURIComponent(value.id);
  const request=jest.fn(async(path:string,method='GET',body?:any)=>{
    if(path===detailPath+'/actions') {
      if(method==='GET')return {replied,replied_at:replied?'2026-10-30T00:00:00Z':null};
      if(method!=='POST'||body.version!==saved.version||!body.client_request_id)throw new Error('Invalid typed action fixture request');
      if(body.kind==='replied'&&saved.kind==='communication') {
        replied=true;saved={...saved,status:'waiting',completed_at:null,version:saved.version+1};
        if(Object.prototype.hasOwnProperty.call(body,'draft'))saved.draft=body.draft;
      } else if(body.kind==='exercise_completed'&&saved.kind==='exercise') {
        saved={...saved,status:'completed',completed_at:'2026-10-30T00:00:00Z',version:saved.version+1};
        if(Object.prototype.hasOwnProperty.call(body,'progress_notes'))saved.progress_notes=body.progress_notes;
      } else throw new Error('Unsupported typed action fixture request');
      return {todo:{...saved},actions:{replied,replied_at:replied?'2026-10-30T00:00:00Z':null},reward:null};
    }
    if(path===detailPath&&method==='PATCH'){saved={...saved,...body,version:saved.version+1};return {...saved};}
    if(path===detailPath+'/prepare'&&method==='POST') {saved={...saved,linked_task_id:'owned-preparation',version:saved.version+1};return {...saved};}
    if(path.startsWith('/todos?')) {const filter=query(path).filter;return {items:filter==='active'?[{...saved}]:[],next_offset:null};}
    if(path===detailPath&&method==='GET')return {...saved};
    throw new Error('Unexpected stored fixture request: '+method+' '+path);
  });return {baseUrl:'https://fixture.invalid',request,saved:()=>saved};
}

it('keeps independent source/kind rows and truthful loaded group counts, then paginates overlaps',async()=>{
  const request=jest.fn(async(path:string)=>{
    const q=query(path),filter=q.filter,offset=q.offset;
    if(filter==='active')return offset==='0'?{items:[todo('learn',{kind:'learning'}),todo('errand',{kind:'errand',source_kind:'integration_import',source_label:'已导入 · shared · 测试来源',source_id:'owned-import'})],next_offset:50}:{items:[todo('learn',{kind:'learning'}),todo('older',{source_kind:'conversation',source_label:'对话 · 测试来源',source_id:'owned-conversation'})],next_offset:null};
    if(filter==='waiting')return {items:[todo('waiting',{status:'waiting'})],next_offset:50};
    if(filter==='suggested')return {items:[todo('candidate',{status:'suggested',source_kind:'conversation',source_label:'对话 · 测试候选',source_id:'owned-candidate-conversation',source_excerpt:'我会处理这件事'})],next_offset:null};
    return {items:[],next_offset:null};
  });
  const app=await mount(<TodosScreen/>,{request,baseUrl:'https://fixture.invalid'});
  expect(texts(app.tree)).toContain('事项learn');expect(texts(app.tree)).toContain('你添加');expect(texts(app.tree)).toContain('分享资料');expect(texts(app.tree)).toContain('等待后续 · 1+');expect(texts(app.tree)).not.toContain('事项waiting');
  await press(app.tree,'加载更多事项');
  expect(app.tree.root.findAllByType(Text).filter(n=>n.props.children==='事项learn')).toHaveLength(1);expect(texts(app.tree)).toContain('事项older');expect(texts(app.tree)).toContain('对话');
  await act(async()=>{app.tree.root.findAll(n=>n.props.accessibilityRole==='tab'&&childText(n.props.children)==='全部'&&typeof n.props.onPress==='function')[0].props.onPress();});
  expect(request.mock.calls.some(([path])=>path.includes('filter=active')&&path.includes('scope=all'))).toBe(true);
  await app.close();
});

it('ignores a late old-owner continuation and refresh replaces only the current owner list',async()=>{
  let list!:ReturnType<typeof useTodoList<Todo>>;
  function Probe({owner,load}:{owner:string;load:(offset:number)=>Promise<{items:Todo[];next_offset:number|null}>}) {list=useTodoList(load,[owner]);return <Text>{list.items.map(t=>t.title).join(',')}</Text>;}
  const late=deferred<{items:Todo[];next_offset:number|null}>();
  const a=jest.fn().mockResolvedValueOnce({items:[todo('a')],next_offset:1}).mockReturnValueOnce(late.promise);
  const b=jest.fn().mockResolvedValueOnce({items:[todo('b')],next_offset:null}).mockResolvedValueOnce({items:[todo('fresh-b')],next_offset:null});
  let tree!:ReactTestRenderer;await act(async()=>{tree=create(<Probe owner="a" load={a}/>);});
  await act(async()=>{list.loadMore();});await act(async()=>tree.update(<Probe owner="b" load={b}/>));
  await act(async()=>late.resolve({items:[todo('secret-a')],next_offset:null}));expect(texts(tree)).toContain('事项b');expect(texts(tree)).not.toContain('secret-a');
  await act(async()=>list.refresh());expect(b).toHaveBeenLastCalledWith(0);expect(texts(tree)).toContain('fresh-b');expect(texts(tree)).not.toContain('事项b\n');await act(async()=>tree.unmount());
});

it('guards duplicate quick-add taps and retains one creation intent for a lost-response retry',async()=>{
  const lost=deferred<any>();const request=jest.fn().mockImplementation((path:string,method?:string)=>method==='POST'?lost.promise:Promise.resolve({items:[],next_offset:null}));
  const app=await mount(<TodosScreen/>,{baseUrl:'https://fixture.invalid',request});await input(app.tree,'记件要做的事','浇花');
  const add=()=>app.tree.root.findAll(n=>n.props.accessibilityLabel==='添加事项'&&typeof n.props.onPress==='function')[0].props.onPress();
  await act(async()=>{add();add();});const posts=()=>request.mock.calls.filter(call=>call[1]==='POST');expect(posts()).toHaveLength(1);const key=posts()[0][2].client_request_id;
  await act(async()=>lost.reject(new Error('response lost')));expect(errors(app.tree)).toContain('response lost');
  request.mockImplementation((path:string,method?:string)=>Promise.resolve(method==='POST'?todo('created'):{items:[],next_offset:null}));await act(async()=>add());expect(posts()).toHaveLength(2);expect(posts()[1][2].client_request_id).toBe(key);expect(app.ctx.invalidate).toHaveBeenCalledTimes(1);await app.close();
});

it('sharing a communication draft never claims a send or waiting until the user confirms replying',async()=>{
  const api=storedApi(todo('mail',{kind:'communication',draft:'用户自己的回复草稿'}));const app=await mount(<TodoDetail id="mail"/>,api);
  await press(app.tree,'分享回复');expect(platform.share).toHaveBeenCalledWith('用户自己的回复草稿','事项mail');expect(api.request.mock.calls.filter(call=>call[1]==='PATCH'||call[1]==='POST')).toHaveLength(0);expect(texts(app.tree)).toContain('实际回复后，再确认进入等待');expect(api.saved().status).toBe('pending');
  await input(app.tree,'修改回复草稿','真实发送给客户的修订版');await press(app.tree,'我已实际回复 → 等待');expect(api.saved().status).toBe('waiting');expect(api.saved().draft).toBe('真实发送给客户的修订版');expect(api.saved().completed_at??null).toBeNull();
  const actions=api.request.mock.calls.filter(([path,method])=>path==='/todos/mail/actions'&&method==='POST');expect(actions).toHaveLength(1);expect(actions[0][2]).toEqual(expect.objectContaining({kind:'replied',version:1,draft:'真实发送给客户的修订版',client_request_id:expect.any(String)}));expect(api.request.mock.calls.filter(call=>call[1]==='PATCH')).toHaveLength(0);await app.close();
});

it('learning preparation is not fabricated previous progress or personal completion',async()=>{
  const api=storedApi(todo('learn',{kind:'learning',draft:'根据真实目标准备的解释和一道练习'}));const app=await mount(<TodoDetail id="learn"/>,api);
  expect(texts(app.tree)).toContain('根据真实目标准备的解释');expect(texts(app.tree)).not.toMatch(/上次已经学过|还差 1 词|4 个词/);expect(api.request.mock.calls.filter(call=>call[1]==='PATCH')).toHaveLength(0);
  await input(app.tree,'进展记录','实际练习还不熟悉');await press(app.tree,'保存进展');expect(api.saved().status).toBe('pending');expect(api.saved().progress_notes).toBe('实际练习还不熟悉');await press(app.tree,'我已完成这次学习');expect(api.saved().status).toBe('completed');await app.close();
});

it('exercise only starts and ends from user actions; 1000 minutes is not truncated into completion',async()=>{
  const api=storedApi(todo('exercise',{kind:'exercise'}));const app=await mount(<TodoDetail id="exercise"/>,api);
  await press(app.tree,'开始这次运动');expect(api.saved().status).toBe('in_progress');
  for(const value of ['0','361','2.5','1000']) {await input(app.tree,'实际运动分钟数（可选）',value);const before=api.request.mock.calls.filter(call=>call[1]==='PATCH'||call[1]==='POST').length;await press(app.tree,'我已完成这次运动');expect(api.request.mock.calls.filter(call=>call[1]==='PATCH'||call[1]==='POST')).toHaveLength(before);expect(api.saved().status).toBe('in_progress');expect(errors(app.tree).join(' ')).toContain('1–360');}
  await input(app.tree,'实际运动分钟数（可选）','23');await press(app.tree,'我已完成这次运动');expect(api.saved().status).toBe('completed');expect(api.saved().progress_notes).toContain('23 分钟（自行记录）');
  const actions=api.request.mock.calls.filter(([path,method])=>path==='/todos/exercise/actions'&&method==='POST');expect(actions).toHaveLength(1);expect(actions[0][2]).toEqual(expect.objectContaining({kind:'exercise_completed',version:2,actual_minutes:23,progress_notes:expect.stringContaining('23 分钟（自行记录）'),client_request_id:expect.any(String)}));expect(api.request.mock.calls.filter(call=>call[1]==='PATCH')).toHaveLength(1);await app.close();
});

it('suggested items cannot prepare or run work before the user admits them',async()=>{
  const api=storedApi(todo('candidate',{status:'suggested',kind:'communication',source_kind:'integration_import',source_label:'已导入 · shared · 测试资料',source_id:'owned-import-candidate',source_excerpt:'我会回复客户'}));const app=await mount(<TodoDetail id="candidate"/>,api);
  expect(texts(app.tree)).toContain('候选事项，请确认后加入');expect(app.tree.root.findAllByType(Button).some(n=>n.props.children==='准备回复草稿')).toBe(false);expect(platform.share).not.toHaveBeenCalled();await press(app.tree,'确认加入');expect(api.saved().status).toBe('pending');expect(app.tree.root.findAllByType(Button).some(n=>n.props.children==='准备回复草稿')).toBe(true);await app.close();
});

it('a late previous account detail read and action cannot publish into the new account',async()=>{
  const late=deferred<Todo>();const a={baseUrl:'https://fixture.invalid',request:jest.fn().mockReturnValue(late.promise)};
  const b=storedApi(todo('same-id',{title:'账号乙的事项',draft:'乙自己的内容'}));const app=await mount(<TodoDetail id="same-id"/>,a,'account-a');await app.owner(b,'account-b');await act(async()=>late.resolve(todo('same-id',{title:'账号甲私有标题',draft:'甲私有草稿'})));
  expect(texts(app.tree)).toContain('账号乙的事项');expect(texts(app.tree)).not.toContain('账号甲私有');expect(platform.share).not.toHaveBeenCalled();expect(app.ctx.invalidate).not.toHaveBeenCalled();await app.close();
});
