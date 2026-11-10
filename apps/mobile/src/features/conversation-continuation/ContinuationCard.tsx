import React, { memo, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, AppState, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Svg, { Rect } from 'react-native-svg';
import { Text } from '../../ui/Text';
import { Icon } from '../../ui/visuals';
import { chatAppearance as colors } from '../../ui/ChatAppearance';
import type { ContinuationCandidate } from './model';

const now=()=>(globalThis as unknown as {performance?:{now:()=>number}}).performance?.now?.()??Date.now();
export const ContinuationCard=memo(function ContinuationCard({candidate,pauseVersion,blocked,error,onDismiss,onResume}: {
  candidate:ContinuationCandidate;pauseVersion:number;blocked:boolean;error?:string;
  onDismiss:()=>void;onResume:()=>void;
}) {
  const [paused,setPaused]=useState(AppState.currentState!=='active'&&AppState.currentState!==null&&AppState.currentState!==undefined);
  const [progress,setProgress]=useState(0);
  const [preview,setPreview]=useState(false);
  const [size,setSize]=useState({width:146,height:42});
  const previousPause=useRef(pauseVersion);
  const deadline=useRef(now()+5000);
  const actions=useRef({onDismiss,blocked});actions.current={onDismiss,blocked};
  const current=useRef(true);
  useEffect(()=>{current.current=true;return()=>{current.current=false;};},[]);
  useEffect(()=>{
    void Promise.resolve(AccessibilityInfo.isScreenReaderEnabled?.()).then(enabled=>{if(enabled&&current.current)setPaused(true);}).catch(()=>{});
    const listener=AccessibilityInfo.addEventListener('screenReaderChanged',enabled=>{if(enabled)setPaused(true);});
    return()=>listener.remove();
  },[]);
  useEffect(()=>{if(previousPause.current!==pauseVersion){previousPause.current=pauseVersion;setPaused(true);}},[pauseVersion]);
  useEffect(()=>{if(blocked)setPaused(true);},[blocked]);
  useEffect(()=>{const listener=AppState.addEventListener('change',value=>{if(value!=='active')setPaused(true);});return()=>listener.remove();},[]);
  useEffect(()=>{
    if(paused||blocked||preview)return;
    let completed=false;
    const timer=setInterval(()=>{
      if(!current.current||completed)return;
      const value=Math.min(1,Math.max(0,1-(deadline.current-now())/5000));
      setProgress(value);
      if(value>=1){completed=true;clearInterval(timer);if(!actions.current.blocked)actions.current.onDismiss();}
    },32);
    return()=>clearInterval(timer);
  },[paused,blocked,preview]);
  const radius=12,width=Math.max(26,size.width-2),height=Math.max(26,size.height-2);
  const perimeter=2*(width+height-4*radius)+2*Math.PI*radius;
  const openPreview=()=>{setPaused(true);setPreview(true);};
  return <View style={css.card} testID="continuation-suggestion">
    <View style={css.heading}><Icon name="history" size={13} color="#96A4C0"/><Text style={css.eyebrow}>这段对话可能用得上</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="这次新对话不再提醒" onPress={onDismiss} style={css.dismiss}><Icon name="close" size={14} color="#9CAAC2"/></Pressable></View>
    <Pressable accessibilityRole="button" accessibilityLabel={`查看推荐对话：${candidate.conversation.title}`} onPress={openPreview} style={css.titleRow}>
      <Text numberOfLines={1} style={css.title}>{candidate.conversation.title}</Text><Icon name="chevronRight" size={14} color="#96A7C9"/>
    </Pressable>
    <Text style={css.reason} numberOfLines={2}>{candidate.reason}</Text>
    {error?<Text style={css.error}>{error}</Text>:null}
    <View style={css.actions}>
      <Pressable accessibilityRole="button" accessibilityLabel="接着这段对话聊" disabled={blocked} onPress={()=>{setPaused(true);onResume();}} style={css.resume}>
        {blocked?<ActivityIndicator size="small" color={colors.accent}/>:<><Text style={css.resumeText}>接着聊</Text><Icon name="chevronRight" size={14} color={colors.accent}/></>}
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="在新对话继续" accessibilityHint={paused?'收起建议并保留当前输入。':'5 秒后默认使用新对话，不会自动发送。'}
        onPress={onDismiss} onFocus={()=>setPaused(true)}
        onLayout={event=>{const {width:w,height:h}=event.nativeEvent.layout;if(w>0&&h>0)setSize(old=>old.width===w&&old.height===h?old:{width:w,height:h});}}
        style={css.stay} testID="continuation-default-button">
        <Text style={css.stayText}>在新对话继续</Text>
        {!paused&&!blocked&&<Text style={css.seconds}>{Math.max(1,Math.ceil((1-progress)*5))}s</Text>}
        {!paused&&!blocked&&<View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <Svg width="100%" height="100%" viewBox={`0 0 ${size.width} ${size.height}`}>
            <Rect x={1} y={1} width={width} height={height} rx={radius} fill="none" stroke="#E3E9F7" strokeWidth={1.6}/>
            <Rect testID="continuation-countdown-outline" x={1} y={1} width={width} height={height} rx={radius} fill="none" stroke="#93ACE4" strokeWidth={1.6} strokeLinecap="round"
              strokeDasharray={[perimeter,perimeter]} strokeDashoffset={perimeter*(1-progress)}/>
          </Svg>
        </View>}
      </Pressable>
    </View>
    <Text style={css.note}>{paused?'已停止倒计时，可自行选择在哪里继续。':'5 秒后默认使用新对话，不会自动发送。'}</Text>
    <Modal transparent visible={preview} animationType="none" onRequestClose={()=>setPreview(false)} statusBarTranslucent>
      <View style={css.scrim}>
        <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel="关闭推荐对话预览" onPress={()=>setPreview(false)}/>
        <View style={css.sheet} accessibilityViewIsModal>
          <View style={css.heading}><Text style={[css.title,{flex:1}]}>{candidate.conversation.title}</Text><Pressable style={css.dismiss} accessibilityRole="button" accessibilityLabel="关闭预览" onPress={()=>setPreview(false)}><Icon name="close" size={18} color={colors.secondary}/></Pressable></View>
          <Text style={css.note}>最近几句对话的节选</Text>
          <ScrollView style={css.preview} keyboardShouldPersistTaps="handled">
            {candidate.conversation.preview.map(message=><View key={message.id} style={[css.message,message.role==='user'&&css.userMessage]}><Text style={[css.previewText,message.role==='user'&&css.userText]}>{message.content||'附件消息'}</Text></View>)}
          </ScrollView>
          <Pressable accessibilityRole="button" accessibilityLabel="带着当前输入接着聊" disabled={blocked} onPress={()=>{setPreview(false);onResume();}} style={[css.resume,{alignSelf:'stretch'}]}><Text style={css.resumeText}>带着当前输入接着聊</Text></Pressable>
          <Text style={[css.note,{textAlign:'center'}]}>打开后保留草稿，由你点击发送。</Text>
        </View>
      </View>
    </Modal>
  </View>;
});
const css=StyleSheet.create({
  card:{backgroundColor:'rgba(255,255,255,0.95)',borderWidth:1,borderColor:'#E2E9FA',borderRadius:20,padding:14,marginBottom:10},
  heading:{flexDirection:'row',alignItems:'center',gap:7},eyebrow:{fontSize:10,lineHeight:18,color:'#96A4C0',flex:1},
  dismiss:{minHeight:36,minWidth:36,alignItems:'center',justifyContent:'center',marginRight:-6},
  titleRow:{flexDirection:'row',alignItems:'center',minHeight:36,gap:6},title:{fontSize:15,lineHeight:23,fontWeight:'600',color:'#52658C',flexShrink:1},
  reason:{fontSize:11,lineHeight:19,color:'#8A9AB7',marginBottom:10},actions:{flexDirection:'row',gap:9,alignItems:'center',flexWrap:'wrap'},
  resume:{backgroundColor:'#EDF2FF',borderRadius:13,minHeight:44,minWidth:84,paddingHorizontal:15,flexDirection:'row',gap:5,alignItems:'center',justifyContent:'center'},
  resumeText:{fontSize:12,lineHeight:19,color:colors.accent,fontWeight:'600'},
  stay:{backgroundColor:'#F4F6FC',borderRadius:13,minHeight:44,flexDirection:'row',alignItems:'center',gap:8,paddingHorizontal:12,overflow:'hidden',maxWidth:'100%'},
  stayText:{fontSize:11,lineHeight:19,color:'#8595B6',flexShrink:1},seconds:{fontSize:10,lineHeight:18,color:'#8198CD',minWidth:16,fontVariant:['tabular-nums']},
  note:{fontSize:9,lineHeight:16,color:'#A0ACC2',marginTop:7},error:{fontSize:11,lineHeight:19,color:'#7D8DA9',marginBottom:8},
  scrim:{flex:1,backgroundColor:'rgba(47,62,91,0.18)',justifyContent:'flex-end',padding:13},sheet:{backgroundColor:'#FCFDFF',borderRadius:24,padding:18,maxHeight:'80%'},
  preview:{maxHeight:350,marginVertical:14},message:{paddingVertical:6,marginBottom:14},userMessage:{backgroundColor:colors.accent,padding:12,borderRadius:17,alignSelf:'flex-end',maxWidth:'90%'},previewText:{fontSize:13,lineHeight:23,color:'#64728C'},userText:{color:'#FFFFFF'},
});
