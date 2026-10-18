/**
 * 探测运行中的 web 应用：客户端模块图里是否已编入 dsh-tmp-cleaner 行，
 * 并（可选）下载该行的 bundle 字节做粗校验。
 *
 * 用法：node test/probe-web.mjs
 */
import { readFileSync } from 'node:fs';

const BASE = process.env.DSH_WEB_PROBE_URL ?? 'http://127.0.0.1:3080/';
const COOKIE_FILE = '/root/.dsh/.verify-cookie';
const ID = 'dsh-tmp-cleaner';

const cookie = readFileSync(COOKIE_FILE, 'utf8').trim();

const index = await fetch(BASE, { headers: { cookie } });
const body = await index.text();
if (index.status !== 200) {
	console.log(`probe: index status ${String(index.status)} — cookie 可能已失效`);
	process.exitCode = 1;
	process.exit();
}
const match = body.match(/globalThis\["__DSH_BOOT__"\]\s*=\s*(\{.*?\})<\/script>/s);
if (match === null) {
	console.log('probe: 服务端 index 中未找到 __DSH_BOOT__');
	process.exitCode = 1;
	process.exit();
}
const boot = JSON.parse(match[1]);
const entry = boot.entries.find((candidate) => candidate.id === ID);
console.log(`probe: 客户端模块图共 ${String(boot.entries.length)} 行；dsh-tmp-cleaner ${entry === undefined ? '未编入（需要重启 web）' : '已编入'}`);
if (entry !== undefined) {
	console.log('probe: row =', JSON.stringify(entry).slice(0, 400));
	try {
		const url = new URL(entry.url ?? entry.bundleUrl ?? '', BASE).toString();
		const res = await fetch(url, { headers: { cookie } });
		const text = await res.text();
		console.log(`probe: bundle ${res.status}，${String(text.length)} 字节；含 settings.section：${String(text.includes('settings.section'))}`);
	} catch (error) {
		console.log('probe: bundle 下载失败：', String(error?.message ?? error));
	}
}
