import test from 'node:test';
import assert from 'node:assert/strict';
import { toolActivity } from './tool-activity.js';
test('public activities contain only finite provider/action codes', () => {
  assert.deepEqual(toolActivity('list_mcp_tools',{provider:'didi',query:'private address'}),{provider:'didi',operation:'discover'});
  assert.deepEqual(toolActivity('call_mcp_tool',{provider:'didi',tool:'estimate-price',arguments:{token:'private'}}),{provider:'didi',operation:'estimate'});
  assert.deepEqual(toolActivity('call_mcp_tool',{provider:'amap',tool:'maps_direction_driving'}),{provider:'amap',operation:'route'});
  assert.deepEqual(toolActivity('call_mcp_tool',{provider:'amap',tool:'maps_geo'}),{provider:'amap',operation:'geocode'});
  assert.deepEqual(toolActivity('call_mcp_tool',{provider:'https://secret',tool:'estimate-price'}),{});
  assert.deepEqual(toolActivity('save_memory',{provider:'didi',tool:'estimate-price'}),{});
  assert.deepEqual(toolActivity('call_mcp_tool',{provider:'didi',tool:{label:'下单成功'}}),{provider:'didi',operation:'execute'});
});
