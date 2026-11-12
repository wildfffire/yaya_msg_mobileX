#!/usr/bin/env node
/**
 * 成员库同步护栏（静态守卫）
 * ============================================================
 * 锁住 2026-11-01 真机事故的三个修复点，防止以后重构时无声回退：
 *
 *   1. **库源失败必须报告失败**：yk1z 库（channelId/yklzId 的唯一权威源）拉不到时，
 *      updateMemberData 必须返回 updated:false 并保留本地缓存，不能拿官方目录顶替。
 *      当时的表现是「UI 弹更新成功（成员 910 · …yk1z 库+官方双源）」，实际房间映射没同步上。
 *   2. **劣化判定必须在回填之前**：旧实现先回填旧值再算覆盖率，nowC 被回填到满值 →
 *      mapLost 永远不成立 → 护栏形同虚设。
 *   3. **不再用 lastMessage 反推 channelId**：一个 serverId 下有大/小两个频道，
 *      `serverToChannel.set(serverId, channelId)` 单值覆盖必然错一半（陈琳 41096185 事件）。
 *
 * 为什么用源码断言而不是单测：这几处都长在 AsyncStorage + 网络 I/O 上，纯 Node 跑不起来；
 * 而它们一旦被改回去，现象是"房间加载失败"而不是抛错，只有静态守卫能第一时间拦住。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const memberData = readFileSync(path.join(root, 'src/services/memberData.ts'), 'utf8');
// 2026-11-11：成员数据同步入口按用户要求从「我的」页迁入设置 → 关于，
// 静态守卫跟着换文件（MyScreen 已不再承载该逻辑）。
const settingsScreen = readFileSync(path.join(root, 'src/screens/SettingsScreen.tsx'), 'utf8');

let pass = 0;
const fails = [];
function check(name, cond) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fails.push(name);
    console.log(`  ✗ ${name}`);
  }
}

console.log('成员库同步护栏：');

// 1) 库源失败 → 明确失败，不写缓存
check('存在库源失败分支 if (!dbOk)', memberData.includes('if (!dbOk)'));
check(
  '库源失败分支返回 updated: false',
  /if \(!dbOk\)[\s\S]{0,700}?updated: false/.test(memberData),
);
check('库源失败文案固定（UI/日志共用）', memberData.includes('成员库源不可用（已保留本地数据）'));
check(
  '库源失败分支直接 return（不落到 persist）',
  /if \(!dbOk\)[\s\S]{0,700}?return \{[\s\S]{0,200}?\};/.test(memberData),
);
check('fetchOfficialMembers 透出 dbOk', /dbOk/.test(memberData) && memberData.includes('dbCount'));

// 2) 劣化判定用回填前覆盖率
check('劣化判定使用回填前的 rawC', memberData.includes('rawC.channel < prevC.channel'));
check('不再存在回填后再算的 nowC 判据', !memberData.includes('nowC.channel <'));

// 3) 反推逻辑已删除
check('不再调用 getLastMessages 反推 channelId', !memberData.includes('getLastMessages'));
// 注释里会保留「当年为什么错」的说明（提到 serverToChannel），所以只断言**不再有声明**
check('不再声明 serverToChannel 单值映射表', !memberData.includes('const serverToChannel'));

// 4) UI 侧如实反馈（设置 → 关于 → 成员数据）
check('「关于」页按 updated 判失败', settingsScreen.includes('if (!res?.updated)'));
check('「关于」页失败走「更新失败」文案', settingsScreen.includes("t('更新失败：{msg}（已保留本地数据）'"));

if (fails.length) {
  console.log(`\n成员库同步护栏：${pass}/${pass + fails.length} 通过，失败 ${fails.length}`);
  process.exit(1);
}
console.log(`\n成员库同步护栏：${pass}/${pass} 通过`);
