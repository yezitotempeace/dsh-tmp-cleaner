/**
 * dsh-tmp-cleaner — 宿主半边。
 *
 * 1) 在 web 启动（或 HMR 重载本插件）时，确保 /root/dsh-bin/tmp-clean 的
 *    watch 守护进程正在运行（幂等；异常只打日志，绝不阻断 web 启动）；
 * 2) 守护进程由 dsh 进程内的看门狗（每 2 分钟）持续续命：Android 的 phantom
 *    process killer 会时不时杀掉这个 detached 子进程，以前只有重启 web 才会
 *    重新拉起，表现就是设置页「守护进程：未运行」；现在掉线后 2 分钟内自动
 *    复活，且即使一直复活失败，到期的清理也由 dsh 进程内兜底执行；
 * 3) 在 webServer 上注册 /tmp-clean/api/* 接口，供「设置 → 临时清理」页
 *    读写同一份配置（/root/.tmp-clean/config.json）。
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const TOOL = '/root/dsh-bin/tmp-clean';
const PID_FILE = '/root/.tmp-clean/watch.pid';
const LOG_FILE = '/root/.tmp-clean/tmp-clean.log';
const CONFIG_FILE = '/root/.tmp-clean/config.json';
const STATE_FILE = '/root/.tmp-clean/state.json';
const MAX_BODY_BYTES = 64 * 1024;

/** 看门狗节奏：每 2 分钟检查一次；重拉守护进程最多每 5 分钟一次。 */
const WATCHDOG_INTERVAL_MS = 120000;
const RESPAWN_COOLDOWN_MS = 300000;
/** 守护进程连续缺席超过该时长，才由 dsh 进程内兜底执行到期清理（避开刚拉起时的竞态）。 */
const FALLBACK_GRACE_MS = 180000;

function pidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** 该 PID 是否确实是 tmp-clean 守护进程（Linux 会复用 PID，只查存活会误判）。 */
function isTmpCleanProcess(pid) {
	try {
		return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('tmp-clean');
	} catch {
		return true; // /proc 不可读时退回旧语义，不误杀
	}
}

/** 守护进程 PID，未运行则 null。 */
function watcherPid() {
	try {
		if (!existsSync(PID_FILE)) return null;
		const pid = Number.parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10);
		return Number.isInteger(pid) && pid > 0 && pidAlive(pid) && isTmpCleanProcess(pid) ? pid : null;
	} catch {
		return null;
	}
}

/** 幂等地确保 watch 守护进程在运行；返回当前存活 PID 或 null。 */
function ensureWatcher(reason = 'boot') {
	try {
		if (!existsSync(TOOL)) return null;
		const running = watcherPid();
		if (running !== null) return running;
		const child = spawn(TOOL, ['watch'], { detached: true, stdio: 'ignore' });
		child.unref();
		console.log(`[dsh-tmp-cleaner] 拉起 tmp-clean watch（${reason}），pid=${child.pid ?? '?'}`);
		return null;
	} catch (error) {
		console.error('[dsh-tmp-cleaner] 启动 tmp-clean watch 失败：', error);
		return null;
	}
}

function readJsonFile(path) {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return null;
	}
}

/** 运行 tmp-clean CLI 并收集输出。 */
function runTool(args, timeout = 120000) {
	return new Promise((resolve) => {
		execFile(TOOL, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
			resolve({
				code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
				stdout: String(stdout ?? ''),
				stderr: String(stderr ?? '')
			});
		});
	});
}

/** 进程内看门狗状态（每个 dsh 进程一份）。 */
let watchdogTimer = null;
let lastSpawnAt = 0;
let watcherDownSince = null;
let fallbackRunning = false;

/** 守护进程不在时，到期清理由 dsh 进程自己执行（避免"没人清理"一直拖到重启）。 */
function fallbackCleanup() {
	if (fallbackRunning) return;
	const cfg = readJsonFile(CONFIG_FILE);
	if (!cfg || cfg.enabled === false) return;
	const hours = Number(cfg.interval_hours);
	if (!(hours > 0)) return;
	const state = readJsonFile(STATE_FILE) ?? {};
	const lastRun = Number(state.last_run_ts) || 0;
	if (Date.now() / 1000 < lastRun + hours * 3600) return;
	fallbackRunning = true;
	const started = Date.now();
	runTool(['run'], 600000).then(
		(result) => {
			const detail = (result.stdout + result.stderr).trim().split('\n').slice(-1)[0] ?? '';
			console.log(
				`[dsh-tmp-cleaner] 守护进程缺席，进程内兜底清理完成（${((Date.now() - started) / 1000).toFixed(1)}s，code=${result.code}）：${detail.slice(0, 200)}`
			);
			fallbackRunning = false;
		},
		(error) => {
			console.error('[dsh-tmp-cleaner] 进程内兜底清理失败：', error);
			fallbackRunning = false;
		}
	);
}

function watchdogTick() {
	try {
		const now = Date.now();
		if (watcherPid() !== null) {
			watcherDownSince = null;
			return;
		}
		if (watcherDownSince === null) {
			watcherDownSince = now;
			console.log('[dsh-tmp-cleaner] 检测到 tmp-clean watch 不在运行，看门狗接管');
		}
		if (now - lastSpawnAt >= RESPAWN_COOLDOWN_MS) {
			lastSpawnAt = now;
			ensureWatcher('watchdog');
		}
		if (now - watcherDownSince >= FALLBACK_GRACE_MS) fallbackCleanup();
	} catch (error) {
		// 定时器里的异常绝不能把 dsh 主进程带走。
		console.error('[dsh-tmp-cleaner] 看门狗 tick 异常：', error);
	}
}

/** 启动进程内看门狗（幂等；unref 不阻止进程退出）。 */
function startWatchdog() {
	if (watchdogTimer !== null) return;
	watchdogTimer = setInterval(watchdogTick, WATCHDOG_INTERVAL_MS);
	if (typeof watchdogTimer.unref === 'function') watchdogTimer.unref();
}

function sendJson(res, status, payload) {
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store'
	});
	res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		let raw = '';
		req.on('data', (chunk) => {
			raw += chunk;
			if (raw.length > MAX_BODY_BYTES) {
				reject(new Error('请求体过大'));
				req.destroy();
			}
		});
		req.on('end', () => {
			if (!raw) {
				resolve({});
				return;
			}
			try {
				resolve(JSON.parse(raw));
			} catch {
				reject(new Error('请求体不是合法 JSON'));
			}
		});
		req.on('error', reject);
	});
}

/** UI 字段名 → CLI 配置键。 */
const CONFIG_FIELDS = {
	enabled: 'enabled',
	interval: 'interval_hours',
	max: 'max_size_gb',
	target: 'target_size_gb',
	minAge: 'min_age_hours',
	poll: 'poll_minutes'
};

/**
 * 读取一次状态，供设置页展示。
 * @param scan 是否扫描 /tmp 实际占用（很慢，7–20 秒；默认跳过，页面秒开）。
 */
async function statusPayload(scan = false) {
	const args = ['status', '--json'];
	if (!scan) args.push('--fast');
	const result = await runTool(args);
	let info = null;
	try {
		info = JSON.parse(result.stdout);
	} catch {
		info = null;
	}
	if (info === null) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || 'tmp-clean status 执行失败');
	}
	let logTail = [];
	try {
		logTail = readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-8);
	} catch {
		logTail = [];
	}
	// 用本进程的校验结果覆盖 CLI 的存活判断（cmdline 校验，避免 PID 复用误报）。
	const pid = watcherPid();
	return {
		ok: true,
		config: {
			enabled: info.enabled,
			interval_hours: info.interval_hours,
			max_size_gb: info.max_size_gb,
			target_size_gb: info.target_size_gb,
			min_age_hours: info.min_age_hours,
			poll_minutes: info.poll_minutes,
			dry_run: info.dry_run
		},
		tmp_size_kb: info.tmp_size_kb,
		tmp_size_human: info.tmp_size_human,
		watcher_alive: pid !== null,
		watcher_pid: pid,
		last_run_iso: info.last_run_iso,
		last_reason: info.last_reason,
		last_freed_human: info.last_freed_human,
		total_freed_human: info.total_freed_human,
		next_interval_due_iso: info.next_interval_due_iso,
		log_tail: logTail
	};
}

async function handleConfig(req, res) {
	const body = await readJsonBody(req);
	const args = [];
	for (const [key, value] of Object.entries(body ?? {})) {
		const field = CONFIG_FIELDS[key];
		if (field) args.push(`${field}=${String(value)}`);
	}
	if (args.length === 0) {
		sendJson(res, 400, { ok: false, error: '没有可识别的配置字段' });
		return;
	}
	const result = await runTool(['config', 'set', ...args]);
	if (result.code !== 0) {
		sendJson(res, 400, { ok: false, error: result.stderr.trim() || result.stdout.trim() });
		return;
	}
	sendJson(res, 200, await statusPayload());
}

async function handleRun(req, res) {
	const body = await readJsonBody(req);
	const args = ['run'];
	if (body && body.dryRun) args.push('--dry-run');
	const result = await runTool(args, 300000);
	const output = (result.stdout + result.stderr).trim();
	sendJson(res, 200, {
		ok: result.code === 0,
		output,
		error: result.code === 0 ? undefined : output || 'tmp-clean run 执行失败'
	});
}

/** POST /tmp-clean/api/revive：手动拉起守护进程（带冷却，避免连点刷进程）。 */
async function handleRevive(req, res) {
	const now = Date.now();
	if (now - lastSpawnAt >= 5000) {
		lastSpawnAt = now;
		ensureWatcher('manual');
	}
	await new Promise((resolve) => setTimeout(resolve, 600));
	sendJson(res, 200, await statusPayload());
}

export function apply(ctx) {
	ensureWatcher('boot');
	startWatchdog();
	try {
		ctx.inject(['webServer'], (webCtx) => {
			const routes = [
				{
					kind: 'exact',
					path: '/tmp-clean/api/status',
					handler: async (req, res) => {
						try {
							let scan = false;
							try {
								scan = new URL(req.url ?? '', 'http://127.0.0.1').searchParams.get('scan') === '1';
							} catch {
								scan = false;
							}
							sendJson(res, 200, await statusPayload(scan));
						} catch (error) {
							sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
						}
					}
				},
				{
					kind: 'exact',
					path: '/tmp-clean/api/revive',
					handler: async (req, res) => {
						if (req.method !== 'POST') {
							sendJson(res, 405, { ok: false, error: '仅支持 POST' });
							return;
						}
						try {
							await handleRevive(req, res);
						} catch (error) {
							sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
						}
					}
				},
				{
					kind: 'exact',
					path: '/tmp-clean/api/config',
					handler: async (req, res) => {
						if (req.method !== 'POST') {
							sendJson(res, 405, { ok: false, error: '仅支持 POST' });
							return;
						}
						try {
							await handleConfig(req, res);
						} catch (error) {
							sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
						}
					}
				},
				{
					kind: 'exact',
					path: '/tmp-clean/api/run',
					handler: async (req, res) => {
						if (req.method !== 'POST') {
							sendJson(res, 405, { ok: false, error: '仅支持 POST' });
							return;
						}
						try {
							await handleRun(req, res);
						} catch (error) {
							sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
						}
					}
				}
			];
			for (const route of routes) {
				webCtx.effect(() => webCtx.webServer.register(route), `tmp-cleaner: ${route.path}`);
			}
		});
	} catch (error) {
		console.error('[dsh-tmp-cleaner] 注册 /tmp-clean/api 失败：', error);
	}
}
