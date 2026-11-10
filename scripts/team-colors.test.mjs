#!/usr/bin/env node
/**
 * 队伍应援色回归锁（纯 Node，零新增依赖）。
 *
 * 权威源：桌面端 yk1z/yaya_msg
 *   src/renderer/bootstrap-shared.js 的 TEAM_COLORS
 *   src/renderer/database/app.jsx 的 TEAM_COLORS（Tailwind 色值，两处一致）
 * 2026-11-09 校正：J/C/K/CII 原先是「按色名取近似」的旧值，GII/IDFT 缺失，预备生是旧灰。
 * 这些色值会同时影响直播列表 / 房间列表的队色徽章与公演卡的队伍色条，改错不会报错，只会出现「颜色不对」。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const constants = readFileSync(path.join(root, 'src/constants/index.ts'), 'utf8');
const schedule = readFileSync(path.join(root, 'src/services/performanceSchedule.ts'), 'utf8');

/** 与 yk1z/yaya_msg 逐项对齐（TEAM J 取 database/app.jsx 的浅色主题值） */
const EXPECTED = {
  SII: '#A1D5ED', NII: '#BE98C7', HII: '#F8941D', X: '#B1D61B',
  G: '#9FBF40', NIII: '#FFE249', Z: '#EA617B',
  B: '#FF4083', E: '#0CC8C3', J: '#192F6B',
  C: '#FEB90D', K: '#FF5043', CII: '#D21217', GII: '#0061C0',
};

let pass = 0;
const fails = [];
function check(name, cond) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fails.push(name); console.log(`  ✗ ${name}`); }
}

console.log('队伍应援色护栏：');

const found = {};
for (const m of constants.matchAll(/'TEAM ([A-Z0-9]+)':\s*'(#[0-9A-Fa-f]{6})'/g)) {
  found[m[1]] = m[2].toUpperCase();
}
for (const [team, color] of Object.entries(EXPECTED)) {
  check(`TEAM ${team} = ${color}`, found[team] === color);
}
check('保留不带 TEAM 前缀的别名（至少 5 个）', /SII: '#A1D5ED'/.test(constants) && /X: '#B1D61B'/.test(constants) && /GII: '#0061C0'/.test(constants));
check('IDFT = #900058', /IDFT: '#900058'/.test(constants));
check('预备生 / 荣誉毕业生 / 海外练习生 = #7B8493', (constants.match(/: '#7B8493'/g) || []).length >= 3);
check('旧的近似值已清除（FF5722 / FF6136 / FFD400 / 9C27B0 / 757575）',
  !/#FF5722|#FF6136|#FFD400|#9C27B0|#757575/.test(constants));
// 排期缓存里持久化了 color 字段，色表一变就必须换 key 强制重算
check('公演排期缓存已升 v4（丢弃旧色值缓存）', /CACHE_KEY = 'yaya_performance_schedule_v4'/.test(schedule));
check('队色查找兼容带/不带 TEAM 前缀', /TEAM_COLORS\[`TEAM \$\{team\}`\] \|\| TEAM_COLORS\[team\]/.test(schedule));

if (fails.length) {
  console.log(`\n队伍应援色护栏：${pass}/${pass + fails.length} 通过，失败 ${fails.length}`);
  process.exit(1);
}
console.log(`\n队伍应援色护栏：${pass}/${pass} 通过`);
