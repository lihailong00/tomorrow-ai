import React, { useRef } from 'react';
import { StyleSheet, Switch, View } from 'react-native';
import { useAction, useApp } from '../../app/context';
import { Text } from '../../ui/Text';
import { Card, ErrorNotice } from '../../ui/components';

export function ContinuationSettings(){
  const app=useApp();const action=useAction();const latest=useRef(app);latest.current=app;
  return <Card><View style={css.row}><View style={css.copy}><Text style={css.title}>新对话续聊建议</Text><Text style={css.note}>在本机匹配当前账号最近 20 个会话。5 秒后默认留在新对话，不会自动发送，也不额外调用模型。</Text></View>
    <Switch accessibilityLabel="新对话续聊建议" value={app.preferences.continuationSuggestions!==false} disabled={action.busy}
      onValueChange={enabled=>action.run(async({isCurrent})=>{if(isCurrent())await latest.current.savePreferences({...latest.current.preferences,continuationSuggestions:enabled});})}/>
    </View><ErrorNotice message={action.error}/></Card>;
}
const css=StyleSheet.create({row:{flexDirection:'row',alignItems:'center',gap:12},copy:{flex:1},title:{fontSize:15,color:'#45516A',marginBottom:7},note:{fontSize:12,lineHeight:21,color:'#8995AC'}});
