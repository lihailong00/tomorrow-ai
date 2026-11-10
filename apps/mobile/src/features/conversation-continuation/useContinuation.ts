import { useEffect, useMemo, useState } from 'react';
import type { ApiClient } from '../../api/client';
import { findContinuation, needsPreviousContext, type ContinuationCandidate } from './model';
import type { createRecentContextIndex } from './recentContext';

export function useContinuation({api,index,owner,userId,server,instance,revision,draft,enabled}: {
  api:ApiClient;index:ReturnType<typeof createRecentContextIndex>;owner:object;
  userId?:string;server?:string;instance?:string;revision?:number;draft:string;enabled:boolean;
}) {
  const scope=useMemo(()=>({active:true,api,index,owner,userId,server,instance,revision}),[api,index,owner,userId,server,instance,revision]);
  const [result,setResult]=useState<{scope:typeof scope;draft:string;candidate:ContinuationCandidate|null}|null>(null);
  useEffect(()=>{scope.active=true;return()=>{scope.active=false;index.cancelPending();};},[scope,index]);
  useEffect(()=>{
    let cancelled=false;
    if(!enabled){index.cancelPending();return;}
    if(!needsPreviousContext(draft))return;
    const timer=setTimeout(()=>{
      void index.load(api,owner,JSON.stringify([userId,server,instance,revision])).then(recent=>{
        if(!cancelled&&scope.active)setResult({scope,draft,candidate:findContinuation(draft,recent)});
      });
    },650);
    return()=>{cancelled=true;clearTimeout(timer);};
  },[api,draft,enabled,index,owner,scope,userId,server,instance,revision]);
  return enabled&&result?.scope===scope&&result.draft===draft?result.candidate:null;
}
