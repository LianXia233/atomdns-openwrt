'use strict';
'require view';
'require fs';
'require poll';
'require rpc';
'require ui';

/*
 * AtomDNS 的 LuCI 概览页（纯 JS 视图，不依赖 Lua CBI）。
 *
 * 状态来源：
 *   - ubus service list：运行状态与 PID
 *   - fs.exec /usr/bin/atomdns version：程序版本
 *   - fs.read /etc/atomdns/config_custom.yaml：DNS / API 监听端口
 *   - fs.read /etc/atomdns/ui/main/ui-manifest.json：WebUI 版本
 *   - fs.read /etc/atomdns/webinfo/rust_config_update_state.json：配置 schema
 *   - fs.stat /etc/rc.d/S99atomdns：开机自启
 *   - /proc/<pid>/status、/proc/<pid>/stat、/proc/uptime：内存、线程、运行时长
 */

var callServiceList = rpc.declare({
	object: 'service',
	method: 'list',
	params: [ 'name', 'verbose' ],
	expect: { '': {} }
});

var BIN      = '/usr/bin/atomdns';
var INIT     = '/etc/init.d/atomdns';
var DNSCTL   = '/usr/bin/atomdns-dnsctl';
var CFGCTL   = '/usr/bin/atomdns-configctl';
var ROOT     = '/etc/atomdns';
var CONF     = ROOT + '/config_custom.yaml';
var MANIFEST = ROOT + '/ui/main/ui-manifest.json';
var STATE    = ROOT + '/webinfo/rust_config_update_state.json';
var STARTER  = '/etc/rc.d/S99atomdns';

function sh(path, args) {
	return fs.exec(path, args || []).catch(function() {
		return { code: -1, stdout: '', stderr: '' };
	});
}

function rd(path) {
	return fs.read(path).catch(function() { return ''; });
}

function exists(path) {
	return fs.stat(path).then(function() { return true; }).catch(function() { return false; });
}

function parseConfig(text) {
	var out = { dns: [], api: '', webuiPort: 9099 };
	var re = /^[ \t]*listen:[ \t]*"?([^"\n#]+?)"?[ \t]*$/gm;
	var m;

	while ((m = re.exec(text)) !== null) {
		var value = m[1].trim();
		if (value !== '' && out.dns.indexOf(value) < 0)
			out.dns.push(value);
	}

	m = /^[ \t]*http:[ \t]*"?([^"\n#]+?)"?[ \t]*$/m.exec(text);
	if (m) {
		out.api = m[1].trim();
		var port = out.api.split(':').pop();
		if (/^[0-9]+$/.test(port))
			out.webuiPort = parseInt(port, 10);
	}

	return out;
}

/* /proc/<pid>/stat 第 22 字段（starttime，单位 clock tick，常规 100Hz） */
function startTicks(stat) {
	var close = stat.lastIndexOf(')');
	if (close < 0)
		return null;

	var fields = stat.slice(close + 2).split(/\s+/);
	var value = parseInt(fields[19], 10);

	return isNaN(value) ? null : value;
}

function fmtUptime(seconds) {
	if (seconds == null)
		return '-';

	seconds = Math.floor(seconds);

	var days = Math.floor(seconds / 86400);
	var hours = Math.floor(seconds % 86400 / 3600);
	var minutes = Math.floor(seconds % 3600 / 60);
	var secs = seconds % 60;

	if (days > 0)
		return days + ' 天 ' + hours + ' 小时';
	if (hours > 0)
		return hours + ' 小时 ' + minutes + ' 分';
	if (minutes > 0)
		return minutes + ' 分 ' + secs + ' 秒';

	return secs + ' 秒';
}

function fmtKB(kb) {
	if (kb == null)
		return '-';
	if (kb >= 1024)
		return (kb / 1024).toFixed(1) + ' MB';

	return kb + ' KB';
}

function loadStatus() {
	return Promise.all([
		sh(BIN, [ 'version' ]),
		callServiceList('atomdns', true).catch(function() { return {}; }),
		exists(STARTER),
		rd(CONF),
		rd(MANIFEST),
		rd(STATE),
		rd('/proc/uptime'),
		sh(DNSCTL, [ 'status' ]),
		sh(CFGCTL, [ 'get' ]),
		sh(CFGCTL, [ 'schema' ]),
		sh(CFGCTL, [ 'logs', '60' ])
	]).then(function(results) {
		var status = {
			version: (results[0].stdout || '').trim(),
			running: false,
			pid: null,
			enabled: results[2],
			cfg: parseConfig(results[3] || ''),
			uiVersion: '',
			schema: null,
			uptime: null,
			rss: null,
			threads: null,
			takeover: false,
			watchdog: false,
			mode: 'relay',
			cfgctl: {}
		};

		try {
			var dnsctl = JSON.parse(results[7].stdout || '{}') || {};
			status.takeover = !!dnsctl.takeover;
			status.watchdog = !!dnsctl.watchdog;
			status.mode = dnsctl.mode === 'direct' ? 'direct' : 'relay';
		}
		catch (e) {}

		try {
			status.cfgctl = JSON.parse(results[8].stdout || '{}') || {};
		}
		catch (e) {
			status.cfgctl = {};
		}

		try {
			status.schemaInfo = JSON.parse(results[9].stdout || '{}') || {};
		}
		catch (e) {
			status.schemaInfo = {};
		}

		status.logRaw = (results[10] && results[10].stdout) || '';

		if (results[4]) {
			try {
				status.uiVersion = JSON.parse(results[4]).ui_version || '';
			}
			catch (e) {}
		}

		if (results[5]) {
			try {
				var state = JSON.parse(results[5]);
				if (typeof state.applied_schema === 'number')
					status.schema = state.applied_schema;
			}
			catch (e) {}
		}

		var instances = ((results[1] || {}).atomdns || {}).instances || {};

		/* 主实例优先；"takeover" 只是一次性脚本实例，不能拿它的 PID 当服务进程 */
		if (instances.main && instances.main.running) {
			status.running = true;
			status.pid = instances.main.pid;
		}
		else {
			Object.keys(instances).forEach(function(name) {
				var instance = instances[name] || {};
				if (instance.running && name !== 'takeover') {
					status.running = true;
					status.pid = instance.pid;
				}
			});
		}

		if (!status.running || !status.pid)
			return status;

		return Promise.all([
			rd('/proc/' + status.pid + '/status'),
			rd('/proc/' + status.pid + '/stat')
		]).then(function(proc) {
			var m = /^VmRSS:\s+([0-9]+)\s+kB/m.exec(proc[0] || '');
			if (m)
				status.rss = parseInt(m[1], 10);

			m = /^Threads:\s+([0-9]+)/m.exec(proc[0] || '');
			if (m)
				status.threads = parseInt(m[1], 10);

			var uptime = parseFloat(((results[6] || '').trim().split(/\s+/))[0]);
			var ticks = startTicks(proc[1] || '');

			if (!isNaN(uptime) && ticks !== null)
				status.uptime = Math.max(0, uptime - ticks / 100);

			return status;
		});
	});
}

function schemaText(status) {
	var info = status.schemaInfo || {};

	if (status.schema != null)
		return String(status.schema) + '（已应用）';

	if (info.required)
		return '程序要求 ' + info.required + '，已应用 ' +
			(info.applied || '0') + '（全新安装，未执行过在线配置升级）';

	return '未记录（服务未运行或未安装配置包）';
}

function webuiURL(status) {
	var scheme = window.location.protocol === 'https:' ? 'https:' : 'http:';
	var host = window.location.hostname || '127.0.0.1';

	return scheme + '//' + host + ':' + status.cfg.webuiPort + '/';
}

function badge(text, ok) {
	return E('span', {
		'style': 'display:inline-block;padding:2px 10px;border-radius:10px;' +
			'font-size:12px;font-weight:600;color:#fff;background:' +
			(ok ? '#2e7d32' : '#b71c1c')
	}, text);
}

function formatAppTime(ts) {
	var m = /^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(ts);

	return m ? (m[1] + '-' + m[2] + ' ' + m[3] + ':' + m[4] + ':' + m[5]) : ts;
}

function formatServiceLine(line) {
	var m = /^\w{3} \w{3}\s+\d+ (\d{2}:\d{2}:\d{2}) \d{4} (\S+) (\S+?)(?:\[\d+\])?: (.*)$/.exec(line);

	if (!m)
		return line;

	var sev = m[2].split('.').pop();
	var level = (sev === 'err' || sev === 'crit' || sev === 'alert' || sev === 'emerg')
		? '错误'
		: (sev === 'warn' || sev === 'warning') ? '警告'
		: (sev === 'notice') ? '提示' : '信息';

	var source = m[3] === 'atomdns' ? 'AtomDNS'
		: m[3] === 'atomdns-dnsctl' ? 'DNS 接管'
		: m[3] === 'procd' ? '进程管理'
		: m[3] === 'dispatcher.uc' ? 'LuCI'
		: m[3];

	return m[1] + ' [' + level + '] ' + source + ' · ' + m[4];
}

function parseLogs(raw) {
	var out = { service: [], error: [], warn: [], info: [] };
	var section = '';

	(raw || '').split('\n').forEach(function(line) {
		line = line.replace(/\r$/, '');

		if (line === '@SERVICE') { section = 'service'; return; }
		if (line === '@APP') { section = 'app'; return; }
		if (line.trim() === '') return;

		if (section === 'service') {
			out.service.push(formatServiceLine(line));
		}
		else if (section === 'app') {
			var m = /^(\S+)\s+(ERROR|WARN|INFO|DEBUG|TRACE)\s+(.*)$/.exec(line);

			if (!m) {
				out.info.push(line);
				return;
			}

			var body = formatAppTime(m[1]) + ' ' + m[3];

			if (m[2] === 'ERROR')
				out.error.push(body);
			else if (m[2] === 'WARN')
				out.warn.push(body);
			else
				out.info.push(body);
		}
	});

	return out;
}

function logBlock(id, title, lines) {
	var text = lines.length ? lines.slice(-40).join('\n') : '暂无';

	return E('div', { 'class': 'cbi-value' }, [
		E('label', { 'class': 'cbi-value-title' }, title + '（' + lines.length + '）'),
		E('div', { 'class': 'cbi-value-field' }, [
			E('pre', {
				'id': 'atomdns-log-' + id,
				'style': 'max-height:180px;overflow:auto;white-space:pre-wrap;' +
					'font-size:12px;line-height:1.45;margin:0;' +
					(lines.length ? '' : 'color:#888')
			}, text)
		])
	]);
}

function kv(name, value) {
	return E('tr', { 'class': 'tr' }, [
		E('td', { 'class': 'td left', 'width': '30%' }, E('strong', {}, name)),
		E('td', { 'class': 'td left' }, value)
	]);
}

function actionButton(label, action, style, context, after) {
	return E('button', {
		'class': 'btn cbi-button ' + style,
		'click': ui.createHandlerFn(context, function() {
			return sh(INIT, [ action ]).then(function(result) {
				if (result.code !== 0)
					throw new Error((result.stderr || result.stdout || ('exit ' + result.code)).trim());

				ui.addTimeLimitedNotification(null, E('p', {}, '已执行：' + label), 2500, 'info');

				return after();
			}).catch(function(err) {
				ui.addNotification(null, E('p', {}, '操作失败：' + err.message), 'error');
			});
		})
	}, label);
}

function ctlButton(label, command, style, context, after) {
	return E('button', {
		'class': 'btn cbi-button ' + style,
		'click': ui.createHandlerFn(context, function() {
			return sh(DNSCTL, [ command ]).then(function(result) {
				if (result.code !== 0)
					throw new Error((result.stderr || result.stdout || ('exit ' + result.code)).trim());

				ui.addTimeLimitedNotification(null, E('p', {}, label + '完成'), 2500, 'info');

				return after();
			}).catch(function(err) {
				ui.addNotification(null, E('p', {}, label + '失败：' + err.message), 'error');
			});
		})
	}, label);
}

function field(label, control) {
	return E('div', { 'class': 'cbi-value' }, [
		E('label', { 'class': 'cbi-value-title' }, label),
		E('div', { 'class': 'cbi-value-field' }, control)
	]);
}

return view.extend({
	load: function() {
		return loadStatus();
	},

	render: function(initial) {
		var context = this;
		var container = E('div', { 'class': 'cbi-map' });

		function refresh() {
			return loadStatus().then(draw);
		}

		function saveAdvanced() {
			var port = (document.getElementById('atomdns-adv-port') || {}).value || '';
			var mode = (document.getElementById('atomdns-adv-mode') || {}).value || '';
			var socks = (document.getElementById('atomdns-adv-socks') || {}).value || '';
			var commands = [
				[ 'set-port', port.trim() ],
				[ 'set-mode', mode ],
				[ 'set-socks', socks.trim() ]
			];
			var chain = Promise.resolve();

			/* 逐个执行：每次写入后 configctl 都会整体校验，并发会互相看到半成品 */
			commands.forEach(function(command) {
				chain = chain.then(function() {
					return sh(CFGCTL, command).then(function(result) {
						if (result.code !== 0)
							throw new Error((result.stderr || result.stdout ||
								'应用设置失败').trim());
					});
				});
			});

			return chain.then(function() {
				return sh(INIT, [ 'restart' ]);
			}).then(function(result) {
				if (result.code !== 0)
					throw new Error((result.stderr || result.stdout || '重启失败').trim());

				ui.addTimeLimitedNotification(null, E('p', {}, '已保存并重启 AtomDNS'), 3000, 'info');

				return refresh();
			}).catch(function(err) {
				ui.addNotification(null, E('p', {}, '保存失败：' + err.message), 'error');
			});
		}

		function draw(status) {
			var scroll = {};

			[ 'service', 'error', 'warn', 'info' ].forEach(function(id) {
				var el = document.getElementById('atomdns-log-' + id);
				if (el)
					scroll[id] = el.scrollTop;
			});

			while (container.firstChild)
				container.removeChild(container.firstChild);

			var dnsText = status.cfg.dns.length
				? status.cfg.dns.join('、') + '（UDP / TCP）'
				: '未从配置中读到';

			var bindText = status.cfg.api || '未从配置中读到';
			if (status.cfg.api.indexOf('127.0.0.1') === 0)
				bindText += '（仅本机可访问，远程 LuCI 打不开 WebUI）';

			var rows = [
				kv('服务状态', [
					badge(status.running ? '运行中' : '已停止', status.running),
					status.pid ? E('span', {}, '　PID ' + status.pid) : ''
				]),
				kv('开机自启', badge(status.enabled ? '已启用' : '未启用', status.enabled)),
				kv('DNS 接管', [
					badge(status.takeover ? '已接管' : '未接管', status.takeover),
					E('span', {}, status.takeover
						? '　LAN :53 → dnsmasq → AtomDNS'
						: '　LAN 仍走原 DNS（HomeProxy/上游）'),
					status.takeover
						? E('span', {}, '　保活：' + (status.watchdog ? '运行中（30s 自检）' : '未运行'))
						: '',
					status.takeover
						? E('span', {}, '　记录：' + (status.mode === 'direct'
							? '直连（真实客户端）'
							: '中继 dnsmasq（127.0.0.1）'))
						: ''
				]),
				kv('运行时长', fmtUptime(status.uptime)),
				kv('内存占用', fmtKB(status.rss) +
					(status.threads != null ? '（' + status.threads + ' 线程）' : '')),
				kv('程序版本', status.version || '-'),
				kv('WebUI 版本', status.uiVersion || '-'),
				kv('DNS 监听', dnsText),
				kv('API / WebUI', bindText),
				kv('配置目录', ROOT),
				kv('配置 schema', schemaText(status))
			];

			var header = E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, 'AtomDNS'),
				E('p', {}, 'MosDNS 兼容的 DNS 分流器，附带缓存、路由学习与查询审计。'),
				E('div', { 'style': 'margin:12px 0' }, [
					E('button', {
						'class': 'btn cbi-button cbi-button-apply',
						'disabled': status.running ? null : 'disabled',
						'click': ui.createHandlerFn(context, function() {
							window.open(webuiURL(status), '_blank');
						})
					}, '打开 WebUI'),
					' ',
					actionButton('启动', 'start', 'cbi-button-apply', context, refresh),
					' ',
					actionButton('停止', 'stop', 'cbi-button-reset', context, refresh),
					' ',
					actionButton('重启', 'restart', 'cbi-button-action', context, refresh),
					' ',
					E('button', {
						'class': 'btn cbi-button ' + (status.enabled ? 'cbi-button-reset' : 'cbi-button-apply'),
						'click': ui.createHandlerFn(context, function() {
							var first = status.enabled ? 'disable' : 'enable';
							var second = status.enabled ? 'stop' : 'start';

							return sh(INIT, [ first ]).then(function() {
								return sh(INIT, [ second ]);
							}).then(function(result) {
								if (result.code !== 0)
									throw new Error((result.stderr || result.stdout || '操作失败').trim());

								ui.addTimeLimitedNotification(null, E('p', {},
									status.enabled ? '已停止并禁用自启（DNS 已恢复）'
										: '已启动并启用自启（DNS 已接管）'), 3000, 'info');

								return refresh();
							}).catch(function(err) {
								ui.addNotification(null, E('p', {}, '操作失败：' + err.message), 'error');
							});
						})
					}, status.enabled ? '停止并禁用自启' : '启动并启用自启')
				])
			]);

			var table = E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, '详细状态'),
				E('table', { 'class': 'table' }, [ E('tbody', {}, rows) ])
			]);

			var parsed = parseLogs(status.logRaw);
			var logs = E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, '日志'),
				E('p', {}, '每 5 秒刷新。按来源/级别细分；级别与来源为中文标注，日志正文保持原文。'),
				logBlock('service', '接管与服务', parsed.service),
				logBlock('error', '应用错误', parsed.error),
				logBlock('warn', '应用警告', parsed.warn),
				logBlock('info', '应用信息', parsed.info)
			]);

			var advanced = E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, '高级设置'),
				E('p', {}, '保存后会重启 AtomDNS 并重新接管；取消接管会立刻恢复原 dnsmasq 设置，' +
					'HomeProxy/sing-box 的代理链路不受影响。'),
				field('DNS 接管', [
					badge(status.takeover ? '已接管' : '未接管', status.takeover), ' ',
					ctlButton('立即接管', 'apply', 'cbi-button-apply', context, refresh), ' ',
					ctlButton('取消接管', 'restore', 'cbi-button-reset', context, refresh)
				]),
				field('DNS 监听端口', E('input', {
					'type': 'text',
					'id': 'atomdns-adv-port',
					'class': 'cbi-input-text',
					'value': String(status.cfgctl.port || '')
				})),
				field('客户端记录', [
					E('select', {
						'id': 'atomdns-adv-client',
						'class': 'cbi-input-select'
					}, [
						E('option', {
							'value': 'relay',
							'selected': status.mode === 'relay' ? 'selected' : null
						}, '中继 dnsmasq（本地名字可用，客户端显示 127.0.0.1）'),
						E('option', {
							'value': 'direct',
							'selected': status.mode === 'direct' ? 'selected' : null
						}, '直连 AtomDNS（真实客户端，.lan 需 hosts）')
					]),
					' ',
					E('button', {
						'class': 'btn cbi-button cbi-button-apply',
						'click': ui.createHandlerFn(context, function() {
							var value = (document.getElementById('atomdns-adv-client') || {}).value;

							return sh(DNSCTL, [ 'set-mode', value ]).then(function(result) {
								if (result.code !== 0)
									throw new Error((result.stderr || result.stdout || '切换失败').trim());

								ui.addTimeLimitedNotification(null, E('p', {},
									value === 'direct' ? '已切换为直连模式（真实客户端）'
										: '已切换为中继模式（dnsmasq）'), 3000, 'info');

								return refresh();
							}).catch(function(err) {
								ui.addNotification(null, E('p', {}, '切换失败：' + err.message), 'error');
							});
						})
					}, '应用'),
					E('p', { 'style': 'margin-top:6px;color:#666' },
						'直连：LAN 的 53 直接交给 AtomDNS，审计/查询日志显示真实客户端 IP，' +
						'但 dnsmasq 的本地 DHCP 名字（.lan）不再参与解析，需要就加到 hosts。' +
						'中继：保留本地名字，客户端统一显示为 127.0.0.1。')
				]),
				field('运行模式', E('select', {
					'id': 'atomdns-adv-mode',
					'class': 'cbi-input-select'
				}, [
					E('option', {
						'value': 'realip',
						'selected': status.cfgctl.mode === 'realip' ? 'selected' : null
					}, 'RealIP 分流（配合 HomeProxy / 代理推荐）'),
					E('option', {
						'value': 'fakeip',
						'selected': status.cfgctl.mode === 'fakeip' ? 'selected' : null
					}, 'FakeIP 分流（需要本机 FakeIP 上游）')
				])),
				field('SOCKS5 代理（可选）', [
					E('input', {
						'type': 'text',
						'id': 'atomdns-adv-socks',
						'class': 'cbi-input-text',
						'placeholder': '127.0.0.1:5330',
						'value': String(status.cfgctl.socks || '')
					}),
					E('p', { 'style': 'margin-top:6px;color:#666' },
						'只填 IP:端口（如 HomeProxy 的 127.0.0.1:5330）。不要填域名：' +
						'AtomDNS 为连代理去解析该域名会形成 DNS 回环。')
				]),
				E('div', { 'class': 'cbi-value' }, [
					E('label', { 'class': 'cbi-value-title' }, ''),
					E('div', { 'class': 'cbi-value-field' }, [
						E('button', {
							'class': 'btn cbi-button cbi-button-apply',
							'click': ui.createHandlerFn(context, saveAdvanced)
						}, '保存并重启'),
						status.cfgctl.override ? E('p', {
							'style': 'margin-top:8px;color:#b26a00'
						}, '检测到 AtomDNS WebUI 已保存过设置（webinfo/settings.json），' +
							'它会覆盖这里的 YAML 修改。') : ''
					])
				])
			]);

			var hint = E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, '说明'),
				E('p', {}, '服务启动后自动接管：LAN 的 :53 先交给 dnsmasq（本地 DHCP 名字仍可解析），' +
					'dnsmasq 再转发给 AtomDNS。停止服务或点“取消接管”会还原 dnsmasq 配置并删除接管规则。'),
				E('p', {}, '与 HomeProxy 搭配时保持 RealIP 模式：国外域名由 AtomDNS 返回真实 IP，' +
					'实际流量仍由 sing-box 的 TUN/分流规则代理。FakeIP 模式需要本机提供 FakeIP 上游。'),
				E('p', {}, 'WebUI 与 API 目前没有认证，9099 端口只应暴露在内网。')
			]);

			container.appendChild(header);
			container.appendChild(table);
			container.appendChild(logs);
			container.appendChild(advanced);
			container.appendChild(hint);

			[ 'service', 'error', 'warn', 'info' ].forEach(function(id) {
				var el = document.getElementById('atomdns-log-' + id);
				if (el && scroll[id])
					el.scrollTop = scroll[id];
			});
		}

		draw(initial);

		poll.add(function() {
			var active = document.activeElement;

			/* 正在编辑高级设置时不要刷新，否则输入框会被重建 */
			if (active && container.contains(active) &&
			    (active.tagName === 'INPUT' || active.tagName === 'SELECT'))
				return Promise.resolve();

			return loadStatus().then(draw);
		}, 5);

		return container;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
