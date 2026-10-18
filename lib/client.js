/**
 * dsh-tmp-cleaner — 浏览器半边（手写 bundle）。
 *
 * 在「设置」面板注册一个「临时清理」页：
 *  - 展示：/tmp 当前占用、守护进程、上次/下次清理、累计释放；
 *  - 编辑：启用开关、容量阈值（超过 → 清到）、周期（小时）、目录年龄（小时）；
 *  - 按钮：保存 / 立即清理 / 演练（dry-run）。
 *
 * 数据经由宿主半边注册的 /tmp-clean/api/* 路由读写；
 * 与命令行 `tmp-clean` 共用同一份配置（/root/.tmp-clean/config.json）。
 */
window.__ModuleLoader__.load({
	id: "dsh-tmp-cleaner",
	factory: (require) => {
		"use strict";
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");
		const jsxRuntime = require("react/jsx-runtime");
		const jsx = jsxRuntime.jsx;
		const jsxs = jsxRuntime.jsxs;
		const { useCallback, useEffect, useState } = react;

		/** 宿主路由前缀。 */
		const API = "/tmp-clean/api";

		/**
		 * 调用宿主接口并解包 {ok:false} 错误。
		 * @param path - 相对 API 前缀的路径。
		 * @param options - fetch 选项。
		 */
		async function call(path, options) {
			const response = await fetch(API + path, options);
			let data = null;
			try {
				data = await response.json();
			} catch (error) {
				data = null;
			}
			if (!response.ok || data === null || data.ok === false) {
				const message = data !== null && data.error ? data.error : `HTTP ${response.status}`;
				throw new Error(message);
			}
			return data;
		}

		/** 把输入框文本转成数字，非法时用兜底值。 */
		function numberOr(value, fallback) {
			const parsed = Number(value);
			return Number.isFinite(parsed) ? parsed : fallback;
		}

		const boxStyle = { lineHeight: "1.7" };
		const titleStyle = { fontWeight: "600", fontSize: "15px", marginBottom: "2px" };
		const hintStyle = { color: "#888", fontSize: "12px" };
		const gridStyle = {
			display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 12px",
			marginTop: "8px", fontSize: "13px"
		};
		const fieldStyle = { display: "flex", alignItems: "center", gap: "8px", marginTop: "6px", fontSize: "13px" };
		const inputStyle = { width: "5em", padding: "2px 6px" };
		const logStyle = {
			marginTop: "8px", padding: "6px 8px", background: "rgba(127,127,127,0.12)",
			fontSize: "11px", lineHeight: "1.5", overflow: "auto", maxHeight: "9em",
			whiteSpace: "pre-wrap", borderRadius: "4px"
		};

		/** 设置面板里的「临时清理」一页。 */
		function TmpCleanerSection() {
			const [info, setInfo] = useState(null);
			const [error, setError] = useState("");
			const [flash, setFlash] = useState("");
			const [busy, setBusy] = useState(false);
			const [enabled, setEnabled] = useState(true);
			const [intervalHours, setIntervalHours] = useState("24");
			const [max, setMax] = useState("20");
			const [target, setTarget] = useState("10");
			const [minAge, setMinAge] = useState("2");

			const reload = useCallback(async (scan = false, retries = 0) => {
				for (let attempt = 0; ; attempt += 1) {
					try {
						const data = await call("/status" + (scan ? "?scan=1" : ""));
						setInfo(data);
						const config = data.config || {};
						setEnabled(config.enabled !== false);
						setIntervalHours(String(config.interval_hours != null ? config.interval_hours : 24));
						setMax(String(config.max_size_gb != null ? config.max_size_gb : 20));
						setTarget(String(config.target_size_gb != null ? config.target_size_gb : 10));
						setMinAge(String(config.min_age_hours != null ? config.min_age_hours : 2));
						setError("");
						return;
					} catch (failure) {
						setError(failure && failure.message ? failure.message : String(failure));
						// web 刚重启时首次请求常失败：自动重试几次，别让页面停在"掉线"。
						if (attempt >= retries) return;
						await new Promise((resolve) => setTimeout(resolve, 1500));
					}
				}
			}, []);

			useEffect(() => {
				reload(false, 2);
			}, [reload]);

			if (error) {
				return jsxs("div", {
					style: boxStyle,
					children: [
						jsx("div", { children: "tmp-clean 状态读取失败：" + error }),
						jsx("div", { style: hintStyle, children: "web 刚重启过时常见；点重试即可，不必刷新整个页面。" }),
						jsx("button", { style: { marginTop: "8px" }, onClick: () => reload(false, 2), children: "重试" })
					]
				});
			}
			if (info === null) {
				return jsx("div", { style: boxStyle, children: "加载中…" });
			}

			const refresh = async (scan) => {
				if (scan) setFlash("正在扫描 /tmp 大小（7 GiB 约需 10–20 秒）…");
				await reload(scan);
				if (scan) setFlash("");
			};

			const run = async (dryRun) => {
				setBusy(true);
				setFlash("");
				try {
					const data = await call("/run", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ dryRun: dryRun })
					});
					setFlash(data.output || (dryRun ? "演练完成" : "清理完成"));
				} catch (failure) {
					setFlash("执行失败：" + (failure && failure.message ? failure.message : String(failure)));
				}
				setBusy(false);
				reload();
			};

			const save = async () => {
				setBusy(true);
				setFlash("");
				try {
					const hours = numberOr(intervalHours, 0);
					await call("/config", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							enabled: enabled ? "true" : "false",
							interval: hours > 0 ? hours + "h" : "off",
							max: numberOr(max, 20) + "GB",
							target: numberOr(target, 10) + "GB",
							minAge: numberOr(minAge, 2) + "h"
						})
					});
					setFlash("已保存 ✓");
				} catch (failure) {
					setFlash("保存失败：" + (failure && failure.message ? failure.message : String(failure)));
				}
				setBusy(false);
				reload();
			};

			const field = (label, value, onChange, hint) => jsx("label", {
				style: fieldStyle,
				children: [
					jsx("span", { style: { minWidth: "9em" }, children: label }),
					jsx("input", {
						style: inputStyle,
						value: value,
						disabled: busy,
						onChange: (event) => onChange(event.target.value)
					}),
					hint ? jsx("span", { style: hintStyle, children: hint }) : null
				]
			});

			return jsxs("div", {
				style: boxStyle,
				children: [
					jsx("div", { style: titleStyle, children: "临时目录清理（/tmp）" }),
					jsx("div", {
						style: hintStyle,
						children: "与命令行 tmp-clean 共用同一份配置；任何一处修改都会立即生效。"
					}),
					jsxs("div", {
						style: gridStyle,
						children: [
							jsx("div", { children: "当前 /tmp：" + (info.tmp_size_human || "未扫描（点「扫描大小」）") }),
							jsx("div", {
								children: "守护进程：" + (info.watcher_alive
									? "运行中 · PID " + info.watcher_pid
									: "未运行（看门狗 2 分钟内自动拉起）")
							}),
							jsx("div", {
								children: "上次清理：" + (info.last_run_iso || "（还没清理过）")
									+ (info.last_reason ? "（" + info.last_reason + "）" : "")
							}),
							jsx("div", {
								children: "下次周期：" + (info.next_interval_due_iso || "（未启用）")
							}),
							jsx("div", { children: "累计释放：" + (info.total_freed_human || "0") })
						]
					}),
					jsx("div", {
						style: hintStyle,
						children: "守护进程掉线时由 dsh 进程内看门狗自动拉起（最多 2 分钟）；即使一直拉不起来，到期的清理也会由 dsh 进程兜底执行，不会再一直显示未运行。"
					}),
					jsx("div", {
						style: { marginTop: "10px", fontSize: "13px" },
						children: jsx("label", {
							children: [
								jsx("input", {
									type: "checkbox",
									checked: enabled,
									disabled: busy,
									onChange: (event) => setEnabled(event.target.checked)
								}),
								" 启用自动清理"
							]
						})
					}),
					field("超过 (GiB)", max, setMax, "→ 清到"),
					field("目标 (GiB)", target, setTarget, null),
					field("周期 (小时)", intervalHours, setIntervalHours, "0 = 关闭周期触发"),
					field("目录年龄 (小时)", minAge, setMinAge, "只清理早于该时长的目录"),
					jsxs("div", {
						style: { marginTop: "12px", display: "flex", gap: "8px", flexWrap: "wrap" },
						children: [
							jsx("button", { disabled: busy, onClick: save, children: "保存" }),
							jsx("button", { disabled: busy, onClick: () => run(false), children: "立即清理" }),
							jsx("button", { disabled: busy, onClick: () => run(true), children: "演练（dry-run）" }),
							jsx("button", { disabled: busy, onClick: () => refresh(false), children: "刷新" }),
							jsx("button", { disabled: busy, onClick: () => refresh(true), children: "扫描大小" })
						]
					}),
					flash
						? jsx("div", { style: { marginTop: "8px", whiteSpace: "pre-wrap", fontSize: "12px" }, children: flash })
						: null,
					info.log_tail && info.log_tail.length > 0
						? jsx("pre", { style: logStyle, children: info.log_tail.slice(-4).join("\n") })
						: null
				]
			});
		}

		/** 需要的客户端服务。 */
		const inject = ["slots"];

		/**
		 * 注册到「设置」页的 settings.section 槽位。
		 * @param ctx - 浏览器插件上下文。
		 */
		function apply(ctx) {
			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{
						name: "settings.section",
						id: "tmp-cleaner",
						order: 60,
						label: () => "临时清理",
						inject: () => ({})
					},
					TmpCleanerSection
				)
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
