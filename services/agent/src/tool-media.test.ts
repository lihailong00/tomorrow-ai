import assert from 'node:assert/strict';
import test from 'node:test';
import { compactMcpMedia } from './tool-media.js';
test('large nested MCP menus keep every code, price, constraint and description while omitting image URLs', () => {
  const rows=Array.from({length:80},(_,id)=>({code:String(id),name:'套餐'+id,price:id+1,description:'限本门店，到店自取，不可叠加优惠',imageUrl:'https://img.example.test/'+ 'a'.repeat(1000),url:'https://menu.example.test/item/'+id}));
  const original={status:'completed',result:{content:[{type:'text',text:JSON.stringify({items:rows})}]}};
  const compact=compactMcpMedia(original) as typeof original & {result_compaction:{omitted_media_fields:number}};
  assert.ok(JSON.stringify(original).length>48000);assert.ok(JSON.stringify(compact).length<48000);
  assert.equal(compact.result_compaction.omitted_media_fields,80);
  const items=JSON.parse(compact.result.content[0]!.text).items;
  assert.equal(items.length,80);
  items.forEach((item:Record<string,unknown>,index:number)=>{const {imageUrl,...expected}=rows[index]!;assert.deepEqual(item,expected);});
  assert.ok(original.result.content[0]!.text.includes('imageUrl'));
});
test('image labels and non-JSON text are not erased and ordinary links are retained', () => {
  const value={result:{content:[{type:'text',text:'图片说明，不是JSON'}],image:'套餐图',url:'https://source.example.test'}};
  assert.equal(compactMcpMedia(value),value);
});
