// 屏蔽词规则单测（parseMaskWordsText / findMaskWords）。
// 运行：node scripts/mask-words.test.mjs（内部先 tsc 编译再交给 node --test）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMaskWords, parseMaskWordsText } from '../src/utils/maskWords';

test('解析：LF 分行、逐行 trim、丢弃空行', () => {
  assert.deepEqual(parseMaskWordsText('苹果\n  香蕉  \n\n橘子\n'), ['苹果', '香蕉', '橘子']);
});

test('解析：兼容 CRLF', () => {
  assert.deepEqual(parseMaskWordsText('苹果\r\n香蕉\r\n'), ['苹果', '香蕉']);
});

test('解析：去掉 UTF-8 BOM（只在开头）', () => {
  assert.deepEqual(parseMaskWordsText('\uFEFF苹果\n香蕉'), ['苹果', '香蕉']);
});

test('解析：空输入 / 非字符串输入返回空数组', () => {
  assert.deepEqual(parseMaskWordsText(''), []);
  assert.deepEqual(parseMaskWordsText(undefined as any), []);
});

test('命中：中文子串命中，返回词表里的原词', () => {
  assert.deepEqual(findMaskWords('我给你带个苹果', ['苹果', '香蕉']), ['苹果']);
});

test('命中：英文忽略大小写', () => {
  assert.deepEqual(findMaskWords('this is SPAM', ['spam']), ['spam']);
});

test('命中：按词表顺序返回，不按出现位置', () => {
  assert.deepEqual(findMaskWords('香蕉比苹果先出现', ['苹果', '香蕉']), ['苹果', '香蕉']);
});

test('不命中：单字符词不参与拦截（避免误伤正常发言）', () => {
  assert.deepEqual(findMaskWords('我的天', ['的']), []);
});

test('去重：词表里重复的词只返回一次', () => {
  assert.deepEqual(findMaskWords('苹果苹果', ['苹果', '苹果']), ['苹果']);
});

test('边界：空文本 / 空词表 / 空白词都不报错', () => {
  assert.deepEqual(findMaskWords('', ['苹果']), []);
  assert.deepEqual(findMaskWords('苹果', []), []);
  assert.deepEqual(findMaskWords('苹果', ['  ', '']), []);
});
