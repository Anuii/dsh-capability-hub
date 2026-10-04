/** 限定名 / glob / include-exclude / searchKeywords（F3-Q4 的读侧过滤规则）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globToRegExp, isToolIncluded, keywordsFor, matchesPattern, qualify, toolCandidates } from '../../src/host/mcp-runtime/atoms/tool-name.ts';

test('限定名与三种寻址拼写', () => {
  assert.equal(qualify('srv', 'read_file'), 'srv__read_file');
  assert.deepEqual(toolCandidates('srv', 'read_file'), ['read_file', 'srv__read_file']);
});

test('glob：* 匹配任意长，其余字面量，大小写不敏感', () => {
  assert.equal(matchesPattern('read_*', 'read_file'), true);
  assert.equal(matchesPattern('read_*', 'srv__read_file'), false, 'glob 是整字段匹配，不做包含');
  assert.equal(matchesPattern('*__read_file', 'srv__read_file'), true);
  assert.equal(matchesPattern('READ_FILE', 'read_file'), true);
  assert.equal(matchesPattern('write_*', 'read_file'), false);
  assert.equal(matchesPattern('read_file', 'read_file_x'), false);
  assert.equal(matchesPattern('a.b', 'axb'), false, '点必须是字面量');
  assert.equal(matchesPattern('a.b', 'a.b'), true);
});

test('globToRegExp 转义元字符', () => {
  assert.equal(globToRegExp('a+b').test('a+b'), true);
  assert.equal(globToRegExp('a+b').test('aab'), false);
  assert.equal(globToRegExp('x*y').test('xyzzy'), true);
});

test('include 先查、exclude 后赢', () => {
  const server = { serverName: 'srv', includeTools: ['read_*', 'write_*'], excludeTools: ['write_secret'] };
  assert.equal(isToolIncluded(server, 'read_file'), true);
  assert.equal(isToolIncluded(server, 'write_file'), true);
  assert.equal(isToolIncluded(server, 'write_secret'), false);
  assert.equal(isToolIncluded(server, 'delete_file'), false, '不在 include 里');
});

test('两者都为空时全部通过', () => {
  assert.equal(isToolIncluded({ serverName: 'srv' }, 'anything'), true);
});

test('只有 include 时其余被挡下', () => {
  assert.equal(isToolIncluded({ serverName: 'srv', includeTools: ['ping'] }, 'ping'), true);
  assert.equal(isToolIncluded({ serverName: 'srv', includeTools: ['ping'] }, 'pong'), false);
});

test('只有 exclude 时其余通过', () => {
  assert.equal(isToolIncluded({ serverName: 'srv', excludeTools: ['ping'] }, 'ping'), false);
  assert.equal(isToolIncluded({ serverName: 'srv', excludeTools: ['ping'] }, 'pong'), true);
});

test('exclude 用限定名也能命中', () => {
  assert.equal(isToolIncluded({ serverName: 'srv', excludeTools: ['srv__ping'] }, 'ping'), false);
});

test('searchKeywords 按原名 / 限定名 / glob 命中并去重', () => {
  const server = {
    serverName: 'srv',
    searchKeywords: { ping: ['连通性'], 'read_*': ['文件'], 'srv__ping': ['连通性'], other: ['x'] },
  };
  assert.deepEqual(keywordsFor(server, 'ping'), ['连通性']);
  assert.deepEqual(keywordsFor(server, 'read_file'), ['文件']);
  assert.deepEqual(keywordsFor(server, 'nope'), []);
});
