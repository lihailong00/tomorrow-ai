import type { ApiClient } from '../../api/client';
import type { Conversation, Message } from '../../domain/types';
import type { RecentContext } from './model';

/** A bounded, route-owned memory cache. Draft text is never sent to this loader. */
export function createRecentContextIndex() {
  let owner: object | undefined, client: ApiClient | undefined;
  let identity='';
  let controller: AbortController | undefined;
  let value: RecentContext[] | undefined;
  let pending: Promise<RecentContext[]> | undefined;
  let generation=0;
  const clear=()=>{generation++;controller?.abort();controller=undefined;pending=undefined;value=undefined;owner=undefined;client=undefined;};
  return {
    clear,
    cancelPending:()=>{if(pending){generation++;controller?.abort();controller=undefined;pending=undefined;}},
    load(api: ApiClient, scope: object, accountIdentity=''): Promise<RecentContext[]> {
      if(client!==api||owner!==scope||identity!==accountIdentity){clear();client=api;owner=scope;identity=accountIdentity;}
      if(value)return Promise.resolve(value);
      if(pending)return pending;
      const request=++generation;controller=new AbortController();const signal=controller.signal;
      const current=()=>request===generation&&!signal.aborted&&client===api&&owner===scope;
      pending=(async()=>{
        const page=await api.request<{items:Conversation[]}>('/conversations?limit=20&offset=0','GET',undefined,signal);
        const seen=new Set<string>();
        const conversations=(Array.isArray(page.items)?page.items:[]).filter(item=>item&&typeof item.id==='string'&&typeof item.title==='string'&&!seen.has(item.id)&&Boolean(seen.add(item.id))).slice(0,20);
        const results: RecentContext[]=[];let cursor=0,failed=false;
        // Existing self-hosted servers work without a migration. Limit HTTP concurrency,
        // trim before retaining, and never fetch an unbounded message history.
        await Promise.all(Array.from({length:Math.min(3,conversations.length)},async()=>{
          while(current()){
            const index=cursor++;if(index>=conversations.length)return;
            const conversation=conversations[index];
            try{
              const response=await api.request<{items:Message[]}>(`/conversations/${encodeURIComponent(conversation.id)}/messages?limit=4&offset=0`,'GET',undefined,signal);
              if(!current())return;
              const preview=(Array.isArray(response.items)?response.items:[]).filter(message=>message&&message.conversation_id===conversation.id&&['user','assistant'].includes(message.role)&&typeof message.content==='string').slice(-4)
                .map(message=>({id:message.id,conversation_id:conversation.id,role:message.role,content:message.content.slice(0,480),created_at:message.created_at}));
              results.push({...conversation,title:conversation.title.slice(0,120),preview,
                excerpts:preview.filter(message=>message.role==='user').map(message=>message.content)});
            }catch(error){
              const code=(error as {code?:string})?.code;
              if(!['not_found','forbidden'].includes(code??''))failed=true;
            }
          }
        }));
        if(!current()||failed)return [];
        value=conversations.flatMap(item=>results.filter(result=>result.id===item.id));
        return value;
      })().catch(()=>[]).finally(()=>{if(current())pending=undefined;});
      return pending;
    },
  };
}
