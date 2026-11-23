# AtomDNS for OpenWrt v1.0.0

首个正式版：把 AtomDNS 打包成单个 OpenWrt apk，带 LuCI 控制台和可逆的 DNS 接管。

## 资产

- `atomdns-1.0.0-r1.apk` — 单包（程序 + 默认配置 + procd 服务 + LuCI 页面 + 接管脚本）
- `SHA256SUMS` — 校验和

## 构成

- 程序：上游 [AtomDNS](https://github.com/jasonxtt/atomdns) **v0.6.6** 源码
- 工具链：**rustup 官方 Rust 1.96.0** + `aarch64-unknown-linux-musl` + `cargo-zigbuild`（静态 musl）
- 打包：OpenWrt apk SDK（mediatek/filogic，`aarch64_cortex-a53`，apk-tools 3.x），**不编译 Rust**
- 版本号：程序与 WebUI 清单均注入 `v1.0.0`

## 安装

```sh
scp atomdns-1.0.0-r1.apk root@<router>:/tmp/
ssh root@<router>
apk add --allow-untrusted /tmp/atomdns-1.0.0-r1.apk
```

安装后：DNS 监听 `5335`（UDP/TCP），WebUI `http://<router>:9099/`，
LuCI 入口「服务 → AtomDNS」。

让 dnsmasq 转发（服务启动时也会自动接管）：

```sh
uci set dhcp.@dnsmasq[0].noresolv='1'
uci -q delete dhcp.@dnsmasq[0].server
uci add_list dhcp.@dnsmasq[0].server='127.0.0.1#5335'
uci commit dhcp
/etc/init.d/dnsmasq restart
```

## 亮点

- **可逆接管**：启动时在 `prerouting priority dstnat - 10` 抢回 LAN 的 53，
  停止时删除规则并还原 dnsmasq；失败安全，不会把 DNS 指向死端口。
- **LuCI 控制台**：状态/PID/内存/版本、接管开关、端口/模式/SOCKS 高级设置、
  插件内中文细分日志。
- **代理友好**：默认 RealIP，国外 DoH 经 HomeProxy/sing-box 的 TUN 自动代理；
  也可在高级设置里填 SOCKS5。
- **开机守卫**：禁用自启后重启也会自动还原 dnsmasq。

## 注意

- 默认 RealIP；没有 FakeIP 上游时不要切回 fakeip。
- WebUI/API 无认证，9099 仅限内网。
- 5353 常被 avahi 占用，因此默认使用 5335。

完整说明见仓库 [README](https://github.com/LianXia233/atomdns-openwrt#readme)。
