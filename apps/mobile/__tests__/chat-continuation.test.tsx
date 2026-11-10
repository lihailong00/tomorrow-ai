import React from 'react';
import { AppState, TextInput } from 'react-native';
import { act,create,type ReactTestRenderer } from 'react-test-renderer';
import { AppProvider,type AppContextValue } from '../src/app/context';
import { ChatScreen,createChatEntryState } from '../src/screens/Chat';
import { ContinuationCard } from '../src/features/conversation-continuation/ContinuationCard';
import type { ChatIntent,Message } from '../src/domain/types';
import type { ContinuationCandidate } from '../src/features/conversation-continuation/model';
jest.mock('../src/platform/ports',()=>({platform:{hasDocumentPicker:true}}));
jest.mock('../src/ui/visuals',()=>({Icon:()=>null,AssistantOrb:()=>null}));
jest.mock('../src/screens/Main',()=>({ModeNotice:()=>null}));
beforeAll(()=>{(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;});
const mounted=new Set<ReactTestRenderer>();
const initialAppState=Object.getOwnPropertyDescriptor(AppState,'currentState');
beforeEach(()=>{jest.useFakeTimers();Object.defineProperty(AppState,'currentState',{configurable:true,writable:true,value:'active'});});
afterAll(()=>{if(initialAppState)Object.defineProperty(AppState,'currentState',initialAppState);});
afterEach(async()=>{await act(async()=>{mounted.forEach(tree=>tree.unmount());});mounted.clear();jest.clearAllTimers();jest.useRealTimers();jest.restoreAllMocks();});
const oldMessages:Message[]=[{id:'u-old',conversation_id:'rust',role:'user',content:'我每天有20分钟学习Rust，先做一个小工具。',created_at:'2026-11-01T01:00:00Z'},
  {id:'a-old',conversation_id:'rust',role:'assistant',content:'先按四周学习计划安排。',created_at:'2026-11-01T01:00:01Z'}];
const draft='我明天只有20分钟，Rust学习计划怎么调整？';
async function tick(ms=700){await act(async()=>{jest.advanceTimersByTime(ms);await Promise.resolve();});}
async function setup(){
  const entry=createChatEntryState();const navigate=jest.fn();
  const api={
    request:jest.fn(async(path:string)=>path.startsWith('/conversations?')?{items:[{id:'rust',title:'Rust学习计划',updated_at:'2026-11-01T01:00:00Z'}]}:{items:oldMessages,next_offset:40,next_before:'u-old'}),
    messages:jest.fn().mockResolvedValue({items:oldMessages,next_offset:40,next_before:'u-old'}),capabilities:jest.fn().mockResolvedValue({items:[],runtime:{model_mode:'pi'}}),
    chatStream:jest.fn(async(intent:ChatIntent,receive:(event:any)=>void)=>{
      const conversation_id=intent.conversation_id??'new-thread';
      receive({id:1,event:'done',data:{response:{conversation_id,user_message:{id:'new-u',conversation_id,role:'user',content:intent.message,created_at:'2026-11-03T01:00:00Z'},message:{id:'new-a',conversation_id,role:'assistant',content:'回复完成',created_at:'2026-11-03T01:00:01Z'}}}});
    }),
  };
  const render=(client=api,userId='owner',enabled=true)=><AppProvider value={{api:client,user:{id:userId},preferences:{serverUrl:'https://selected.test',continuationSuggestions:enabled},formatDate:()=>'',invalidate:jest.fn(),navigate} as unknown as AppContextValue}><ChatScreen entryState={entry}/></AppProvider>;
  let tree!:ReactTestRenderer;await act(async()=>{tree=create(render());});mounted.add(tree);
  const control=(label:string)=>tree.root.findAll(node=>node.props.accessibilityLabel===label&&typeof node.props.onPress==='function')[0];
  return {api,entry,tree,control,
    input:()=>tree.root.findByType(TextInput),
    type:async(text:string)=>{await act(async()=>tree.root.findByType(TextInput).props.onChangeText(text));},
    press:async(label:string)=>{await act(async()=>{await control(label).props.onPress();});},
    owner:async()=>{const other={...api,request:jest.fn().mockResolvedValue({items:[]})};await act(async()=>tree.update(render(other,'other')));},
    disable:async()=>{await act(async()=>tree.update(render(api,'owner',false)));},
    attach:async()=>{await act(async()=>entry.update(old=>({...old,attachment:{file:{uri:'file:///synthetic.txt',name:'synthetic.txt',mime_type:'text/plain',size:10},upload:{id:'upload-one',name:'synthetic.txt',mime_type:'text/plain',size:10,created_at:'',uri:'private'}}})));},
  };
}
test('offers real previous context without blocking send; timeout keeps the unsent draft and attachment',async()=>{
  const app=await setup();await app.attach();await app.type(draft);await tick();
  expect(app.tree.root.findAll(node=>node.props.testID==='continuation-suggestion').length).toBeGreaterThan(0);
  expect(app.control('发送消息').props.disabled).toBeFalsy();
  await tick(2500);
  const outline=app.tree.root.findAll(node=>node.props.testID==='continuation-countdown-outline'&&typeof node.props.strokeDashoffset==='number')[0];
  expect(outline.props.strokeDashoffset).toBeGreaterThan(0);expect(outline.props.strokeDashoffset).toBeLessThan(outline.props.strokeDasharray[0]);
  await tick(2600);
  expect(app.tree.root.findAll(node=>node.props.testID==='continuation-suggestion')).toHaveLength(0);
  expect(app.input().props.value).toBe(draft);expect(app.entry.getSnapshot().attachment?.upload?.id).toBe('upload-one');
  expect(app.api.chatStream).not.toHaveBeenCalled();expect(app.entry.getSnapshot().id).toBeUndefined();
  await app.type(draft+' 再看看');await tick();expect(app.tree.root.findAll(node=>node.props.testID==='continuation-suggestion')).toHaveLength(0);
});
test('resume verifies and loads the chosen thread, preserves all draft payload, and sends only on tap',async()=>{
  const app=await setup();await app.attach();await app.type(draft);await tick();
  await app.press('接着这段对话聊');
  expect(app.entry.getSnapshot().id).toBe('rust');expect(app.input().props.value).toBe(draft);
  expect(app.entry.getSnapshot().attachment?.upload?.id).toBe('upload-one');expect(app.api.chatStream).not.toHaveBeenCalled();
  expect(app.entry.history.getSnapshot()).toMatchObject({initialized:true,nextOffset:40,nextBefore:'u-old'});
  await app.press('发送消息');
  expect(app.api.chatStream).toHaveBeenCalledTimes(1);
  expect(app.api.chatStream.mock.calls[0][0]).toMatchObject({message:draft,conversation_id:'rust',upload_ids:['upload-one']});
  expect(app.entry.getSnapshot().continuationTarget).toBeNull();
});
test('returning to a new conversation preserves edited draft, attachment and clears old history cursors',async()=>{
  const app=await setup();await app.attach();await app.type(draft);await tick();await app.press('接着这段对话聊');
  await app.type(draft+' 我再补充一点');await app.press('回到新对话并保留输入');
  expect(app.entry.getSnapshot()).toMatchObject({id:undefined,messages:[],draft:draft+' 我再补充一点',continuationDismissed:true});
  expect(app.entry.getSnapshot().attachment?.upload?.id).toBe('upload-one');expect(app.entry.history.getSnapshot().nextBefore).toBeNull();
  await app.press('发送消息');expect(app.api.chatStream.mock.calls[0][0].conversation_id).toBeNull();
});
test('an ordinary same-topic question does not read history or show a suggestion',async()=>{
  const app=await setup();await app.type('Rust里的所有权是什么意思？');await tick(7000);
  expect(app.api.request).not.toHaveBeenCalled();expect(app.tree.root.findAll(node=>node.props.testID==='continuation-suggestion')).toHaveLength(0);
});
test('editing or previewing a candidate stops automatic dismissal',async()=>{
  const app=await setup();await app.type(draft);await tick();
  await act(async()=>app.input().props.onFocus());await tick(6000);
  expect(app.tree.root.findAll(node=>node.props.testID==='continuation-suggestion').length).toBeGreaterThan(0);
  await app.press('查看推荐对话：Rust学习计划');await tick(6000);
  expect(app.control('带着当前输入接着聊')).toBeDefined();expect(app.api.chatStream).not.toHaveBeenCalled();
});
test('turning suggestions off or changing owner rejects old matches without losing text',async()=>{
  const app=await setup();await app.type(draft);await tick();await app.disable();await tick(6000);
  expect(app.tree.root.findAll(node=>node.props.testID==='continuation-suggestion')).toHaveLength(0);expect(app.input().props.value).toBe(draft);
  await app.owner();await tick();expect(app.tree.root.findAll(node=>node.props.testID==='continuation-suggestion')).toHaveLength(0);
});
test('failed selection and a late old-owner response never move or send the draft',async()=>{
  const app=await setup();await app.type(draft);await tick();
  app.api.request.mockRejectedValueOnce(new Error('暂时无法读取'));await app.press('接着这段对话聊');
  expect(app.entry.getSnapshot().id).toBeUndefined();expect(app.input().props.value).toBe(draft);
  let resolve!:(value:any)=>void;app.api.request.mockImplementationOnce(()=>new Promise(yes=>{resolve=yes;}));
  await act(async()=>{app.control('接着这段对话聊').props.onPress();});
  await app.owner();await act(async()=>{resolve({items:oldMessages});});
  expect(app.entry.getSnapshot().id).toBeUndefined();expect(app.input().props.value).toBe(draft);expect(app.api.chatStream).not.toHaveBeenCalled();
});
test('countdown stops when the app leaves foreground',async()=>{
  let listener:((state:string)=>void)|undefined;
  jest.spyOn(AppState,'addEventListener').mockImplementation((_kind,callback)=>{listener=callback as (state:string)=>void;return{remove:jest.fn()};});
  const candidate:ContinuationCandidate={conversation:{id:'rust',title:'Rust',updated_at:'',excerpts:[],preview:[]},reason:'相关记录',score:10};
  const onDismiss=jest.fn();let tree!:ReactTestRenderer;await act(async()=>{tree=create(<ContinuationCard candidate={candidate} pauseVersion={0} blocked={false} onDismiss={onDismiss} onResume={jest.fn()}/>);});mounted.add(tree);
  await tick(1000);await act(async()=>listener?.('background'));await tick(6000);expect(onDismiss).not.toHaveBeenCalled();
});
