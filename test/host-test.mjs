/**
 * 宿主半边离线测试：
 * 用假 ctx 调 apply()，断言路线注册形状，并直接调用处理函数
 * （真跑 /root/dsh-bin/tmp-clean CLI）。
 */
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { apply } from '../lib/index.js';

const routes = [];
const effects = [];

function fakeWebCtx() {
	return {
		webServer: {
			register(route) {
				routes.push(route);
				return () => {};
			}
		},
		effect(fn, label) {
			effects.push(label);
			const dispose = fn();
			return dispose ?? (() => {});
		}
	};
}

const ctx = {
	effect(fn, label) {
		effects.push(label);
		const dispose = fn();
		return dispose ?? (() => {});
	},
	inject(services, callback) {
		assert.deepEqual(services, ['webServer']);
		callback(fakeWebCtx());
	}
};

apply(ctx);

assert.equal(routes.length, 4, 'registers four routes');
const paths = routes.map((route) => route.path).sort();
assert.deepEqual(paths, [
	'/tmp-clean/api/config',
	'/tmp-clean/api/revive',
	'/tmp-clean/api/run',
	'/tmp-clean/api/status'
]);

function makeRes() {
	return {
		statusCode: null,
		headers: null,
		body: '',
		writeHead(code, headers) {
			this.statusCode = code;
			this.headers = headers;
		},
		end(chunk) {
			if (chunk !== undefined && chunk !== null) this.body += String(chunk);
		}
	};
}

function makeReq(method, body) {
	const req = new Readable({ read() {} });
	req.method = method;
	if (body !== undefined) req.push(JSON.stringify(body));
	req.push(null);
	return req;
}

const statusRoute = routes.find((route) => route.path.endsWith('/status'));
const reviveRoute = routes.find((route) => route.path.endsWith('/revive'));
const configRoute = routes.find((route) => route.path.endsWith('/config'));
const runRoute = routes.find((route) => route.path.endsWith('/run'));

{
	const res = makeRes();
	await statusRoute.handler(makeReq('GET'), res);
	assert.equal(res.statusCode, 200);
	const data = JSON.parse(res.body);
	assert.equal(data.ok, true);
	assert.equal(typeof data.config.max_size_gb, 'number');
	// 默认走 --fast：不扫描 /tmp（7 GiB 要 10–20 秒），页面必须秒开。
	assert.equal(data.tmp_size_kb, null);
	assert.equal(data.tmp_size_human, null);
	assert.ok(Array.isArray(data.log_tail));
	console.log('[host-test] status(fast):', JSON.stringify({
		watcher: data.watcher_alive,
		max: data.config.max_size_gb,
		target: data.config.target_size_gb,
		interval: data.config.interval_hours
	}), '| pid:', data.watcher_pid);
}

{
	// ?scan=1 才做完整扫描。
	const req = makeReq('GET');
	req.url = '/tmp-clean/api/status?scan=1';
	const res = makeRes();
	await statusRoute.handler(req, res);
	assert.equal(res.statusCode, 200);
	const data = JSON.parse(res.body);
	assert.equal(typeof data.tmp_size_kb, 'number');
	assert.equal(typeof data.tmp_size_human, 'string');
	console.log('[host-test] status(scan=1):', data.tmp_size_human);
}

{
	const res = makeRes();
	await reviveRoute.handler(makeReq('POST'), res);
	assert.equal(res.statusCode, 200);
	const data = JSON.parse(res.body);
	assert.equal(data.ok, true);
	console.log('[host-test] revive: watcher_alive=' + data.watcher_alive, 'pid=' + data.watcher_pid);
}

{
	const res = makeRes();
	await configRoute.handler(makeReq('POST', {
		interval: '24h', max: '20GB', target: '10GB', minAge: '2h', enabled: 'true'
	}), res);
	assert.equal(res.statusCode, 200);
	const data = JSON.parse(res.body);
	assert.equal(data.ok, true);
	assert.equal(data.config.max_size_gb, 20);
	assert.equal(data.config.target_size_gb, 10);
	assert.equal(data.config.interval_hours, 24);
	assert.equal(data.config.min_age_hours, 2);
	console.log('[host-test] config write round-trip: OK');
}

{
	const res = makeRes();
	await configRoute.handler(makeReq('GET'), res);
	assert.equal(res.statusCode, 405);
	console.log('[host-test] GET on config rejected: OK');
}

{
	const res = makeRes();
	await runRoute.handler(makeReq('POST', { dryRun: true }), res);
	assert.equal(res.statusCode, 200);
	const data = JSON.parse(res.body);
	assert.equal(data.ok, true);
	assert.ok(typeof data.output === 'string');
	console.log('[host-test] dry-run output:', JSON.stringify(data.output.slice(0, 80)));
}

console.log('[host-test] PASS — effects:', effects.length, 'routes:', paths.join(', '));
