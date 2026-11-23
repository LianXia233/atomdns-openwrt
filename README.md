# AtomDNS 的 OpenWrt APK 包（单包 + DNS 接管）

把 [jasonxtt/atomdns](https://github.com/jasonxtt/atomdns)（纯 Rust 版 MosDNS）的官方静态
musl 二进制、默认配置、procd 服务、LuCI 页面、DNS 接管/恢复脚本打成**一个 apk**
（`apk-tools` 3.x，OpenWrt main / ImmortalWrt SNAPSHOT）。

服务启动即接管 LAN DNS，停止即自动还原；与 HomeProxy（sing-box TUN）并存，不改动代理链路。

## 产物

| 文件 | 大小 | 说明 |
| --- | --- | --- |
| `atomdns-0.6.6-r14.apk` | 7.0 MB | 单包：程序 + 配置 + LuCI + 接管脚本 |

sha256：`ed1202aede3279377c38723b093998402f91178ef770025e818fd3e4e4214a63`

包内结构：

```
/usr/bin/atomdns                    上游静态 musl 二进制
/usr/bin/atomdns-dnsctl             DNS 接管/恢复（nft + dnsmasq 快照）
/usr/bin/atomdns-configctl          高级设置读写（端口/模式/SOCKS）
/etc/init.d/atomdns                 procd 服务（主实例 + 一次性接管实例）
/etc/init.d/atomdns-recover         开机守卫：服务不自启时还原 dnsmasq
/etc/atomdns/…                      默认配置（含 ui/main 与规则）
/etc/apk/protected_paths.d/atomdns.list
/www/luci-static/resources/view/atomdns/overview.js
/usr/share/luci/menu.d/luci-app-atomdns.json
/usr/share/rpcd/acl.d/luci-app-atomdns.json
```

## 为什么需要“接管”

这台路由器上 **HomeProxy 的 sing-box 会劫持 LAN 的 53 端口**：

```
table inet sing-box
  chain prerouting_prematch  priority dstnat - 1   # 给本地源打标/放行
  chain prerouting           priority dstnat + 2   # LAN :53 DNAT 到 172.19.0.2
table inet dnsmasq
  chain prerouting           priority dstnat + 5   # 已被 sing-box 抢先
```

所以只改 dnsmasq 上游是**不生效**的。`atomdns-dnsctl` 的做法：

1. 建一张独立表 `inet atomdns`，链挂在 `prerouting priority dstnat - 10`（早于 sing-box）：
   `iifname br-lan udp/tcp dport 53 → redirect to :53`，把 LAN DNS 抢回本机 dnsmasq；
2. 快照 dnsmasq 原有 `noresolv` / `server` 到 `/etc/atomdns/dns-takeover.state`；
3. 设置 `noresolv=1`、`server=127.0.0.1#5335`，重启 dnsmasq；
4. 停止时删表、还原快照、重启 dnsmasq。

这样 LAN 的本地 DHCP 名字仍由 dnsmasq 回答，其余查询交给 AtomDNS。

失败安全：AtomDNS 进程/端口没起来时 `apply` 直接放弃，不改 dnsmasq，DNS 保持原状。

## 代理兼容（HomeProxy / sing-box）

- **默认运行模式改为 RealIP**（上游默认 FakeIP，但 FakeIP 需要本机 6666/1053 上游；
  这台机器没有，FakeIP 会让被代理域名解析失败）。
- AtomDNS 的国外上游仍是 DoH（`dns.google` / `cloudflare`，带 `dial_addr`）。路由器自身到
  `8.8.8.8:443` 的 TCP 会被 sing-box 的 TUN/auto_redirect 接走并走代理，所以**不需要额外配
  SOCKS**，代理域名也能解析出真实 IP。
- 国内 DoH（`dns.alidns.com`，`dial_addr 223.5.5.5`）按国内 IP 直连。
- 不改 HomeProxy 的 nft/TUN/DNS 配置；接管只增加 `inet atomdns` 表，停止即删除。
- 如果部署方式不经过 TUN（例如只用 SOCKS 端口），可在 LuCI 高级设置里填
  `SOCKS5 代理 = 127.0.0.1:5330`（HomeProxy 的 mixed 端口），国外 DoH 会经它连接。

## 安装

```sh
scp dist/atomdns-0.6.6-r14.apk root@<router>:/tmp/
ssh root@<router>
apk add --allow-untrusted /tmp/atomdns-0.6.6-r14.apk
```

自建包无签名索引，必须 `--allow-untrusted`。安装后 postinst 会：

1. `enable` 服务与开机守卫；
2. 重启 AtomDNS（启动 procd 主实例 + 一次性接管实例 → 自动接管 DNS）；
3. 清 LuCI 缓存并重启 rpcd。

## 启动 / 停止 / 恢复行为

| 操作 | DNS 行为 |
| --- | --- |
| `start` / 开机自启 | 等 AtomDNS 监听后接管；失败则保持原 DNS |
| `stop` | 删除 nft 表、还原 dnsmasq 快照，LAN 回落到 HomeProxy/sing-box DNS |
| `restart` | stop 还原 → start 重新接管 |
| `disable` + `stop`（LuCI「停止并禁用自启」） | 停止并还原，重启后也不接管 |
| 禁用自启后重启（未 stop） | `atomdns-recover` 在 START=95 检测到 S99 不存在，自动还原 dnsmasq |
| 卸载 | prerm 先 restore 再停止，避免留下指向 5335 的 dnsmasq 配置 |

## LuCI 页面（服务 → AtomDNS）

纯 JS 视图 + rpcd ACL，不使用 Lua。内容包括：

- 服务状态、PID、运行时长、内存/线程、程序/WebUI 版本、监听端口、配置目录；
- **配置 schema**：从本机 `/api/v1/system/health` 读 `required_config_schema` /
  `applied_config_schema`（全新安装显示“程序要求 7，已应用 0”）；
- **DNS 接管状态**（已接管 / 未接管）；
- **插件内日志**（不跳转系统日志页）：分四块显示——
  **接管与服务**（logread 中 atomdns/atomdns-dnsctl/procd）、
  **应用错误 / 应用警告 / 应用信息**（`/tmp/mosdns.log` 按级别）。
  级别与来源用中文标注（如 `01:38:07 [错误] DNS 接管 · …`），日志正文保持原文；
  每 10 秒刷新，并保留各块的滚动位置；
- 启动 / 停止 / 重启 / 停止并禁用自启；
- **打开 WebUI**（`http://<router>:9099/`，服务停止时置灰）；
- **高级设置**：
  - 立即接管 / 取消接管；
  - DNS 监听端口（写回 `config_custom.yaml` 的 `listen:`，保留绑定地址）；
  - 运行模式 RealIP / FakeIP；
  - SOCKS5 代理（写回 `sub_config/settings.yaml` 的 `main_proxy.addr`）；
  - 保存并重启；写前备份、写后 `atomdns check` 校验，失败自动回滚；
  - 若 AtomDNS WebUI 已生成 `webinfo/settings.json`，页面会提示它会覆盖 YAML 修改。

ACL 只授予：读配置/manifest/`/proc`，执行 `atomdns` 与两个 ctl 脚本、init 脚本，
以及 ubus `service list`。

## 构建

```sh
# 1. 源包（上游 release 的 atomdns-linux-arm64.tar.gz + config_rust.zip）
./build-bundle.sh atomdns-linux-arm64.tar.gz config_rust.zip dist
#    脚本会把 listen 改成 :5335、dns_mode 默认改成 realip，并打印 sha256

# 2. 填 PKG_HASH 后放进 apk SDK 编译
cp dist/atomdns-openwrt-0.6.6-aarch64.tar.gz <sdk>/dl/
cp -r . <sdk>/package/atomdns
cd <sdk> && make defconfig && make package/atomdns/compile V=s
# 产物：bin/packages/aarch64_cortex-a53/base/atomdns-0.6.6-r14.apk
```

示例 SDK：`mediatek/filogic` snapshot（`aarch64_cortex-a53`，apk-tools 3.0.5）。

## 实机验证（2026-11-24，测试路由器）

设备：ImmortalWRT SNAPSHOT / mediatek-filogic / `aarch64_cortex-a53`，HomeProxy + sing-box TUN。

- 安装 `atomdns-0.6.6-r14.apk`；`apk list -I` 显示 installed，服务 `running` + `enabled`。
- 自动接管：`atomdns-dnsctl status` → `{"running":1,"takeover":1,"port":"5335","state":true}`；
  nft 表 `inet atomdns` 计数增长；dnsmasq `noresolv=1`、`server=127.0.0.1#5335`。
- LAN DNS（LAN 客户端 → 路由器）：`www.baidu.com` 返回国内 IP，
  `www.google.com` / `www.youtube.com` 返回真实 Google IP。
- 代理未受影响：路由器 `curl https://www.google.com` → **200（约 0.7s）**；
  `homeproxy status` 仍为 running。
- `stop`：takeover=0、nft 表删除、dnsmasq 恢复为空；LAN DNS 仍可解析（sing-box），代理 200。
- `start`：takeover=1，LAN DNS 恢复走 AtomDNS。
- `restart`：重新接管成功。
- 无头 Chromium 实测 LuCI：状态表、打开 WebUI 新窗口、取消接管/立即接管、
  “保存并重启”全部通过，无 JS 错误（唯一 403 是未登录访问 `/cgi-bin/luci/` 的预期响应）。
- `atomdns check`：`SUMMARY gaps=0 cascades=0 globals=0 definitions=84`。

## 注意

1. **默认 RealIP**。没有 FakeIP 上游时不要切回 fakeip，否则被代理域名解析失败。
2. WebUI/API 无认证，9099 只应在内网暴露。
3. `/etc/atomdns/` 整体在 apk 保护路径内，升级时新配置会落成 `*.apk-new`（旧配置保留）；
   需要新默认值时手工合并。升级后服务会自动重启并重新接管。
4. 5353 端口被 avahi/mDNS 占用，所以默认用 **5335**；改端口请用 LuCI 高级设置。
5. 在线自更新在 arm64 上本来就不支持（`platform_supported()` 仅 x86_64），升级统一走 apk。

## 许可

本仓库只包含 OpenWrt 打包脚本、procd 初始化脚本、DNS 接管/恢复脚本与 LuCI 视图，
均为 GPL-3.0（见 `LICENSE`）。AtomDNS 本体版权归上游作者
[jasonxtt/atomdns](https://github.com/jasonxtt/atomdns)（GPL-3.0）；
本仓库不分发二进制，`build-bundle.sh` 从上游 Release 拉取静态二进制后再打包。
