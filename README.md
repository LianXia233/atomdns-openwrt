<div align="center">

# AtomDNS for OpenWrt

**单包 APK · LuCI 控制台 · DNS 自动接管/恢复 · 与 HomeProxy 共存**

[![Build](https://github.com/LianXia233/atomdns-openwrt/actions/workflows/build.yml/badge.svg)](https://github.com/LianXia233/atomdns-openwrt/actions/workflows/build.yml)
[![Release](https://img.shields.io/github/v/release/LianXia233/atomdns-openwrt?style=flat-square&color=2f81f7&label=release)](https://github.com/LianXia233/atomdns-openwrt/releases)
[![License](https://img.shields.io/badge/license-GPL--3.0-3fb950?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-OpenWrt%20apk%20%7C%20aarch64__cortex--a53-8957e5?style=flat-square)](#)
[![Rust](https://img.shields.io/badge/rust-1.96%20official%20toolchain-orange?style=flat-square&logo=rust)](#)
[![Upstream](https://img.shields.io/badge/upstream-atomdns%20v0.6.6-555?style=flat-square)](https://github.com/jasonxtt/atomdns)

</div>

---

把 [AtomDNS](https://github.com/jasonxtt/atomdns)（纯 Rust 版 MosDNS）打包成 **一个 OpenWrt apk**：
程序、默认配置、procd 服务、LuCI 页面、DNS 接管/恢复脚本全部在内。
面向 `aarch64_cortex-a53`（mediatek/filogic 等）与 `apk-tools` 3.x 的 OpenWrt / ImmortalWrt SNAPSHOT。

> **发布版本 v1.0.0** 是打包版本号；内置程序由上游 AtomDNS **v0.6.6** 源码编译，
> 使用 **rustup 官方工具链**（`aarch64-unknown-linux-musl` + `cargo-zigbuild`）生成静态 musl 二进制。
> OpenWrt SDK 只负责打包，**不在 OpenWrt 里编译 Rust**。

## ✨ 特性

| | 功能 | 说明 |
| --- | --- | --- |
| 🧩 | **单包安装** | 一个 `.apk` 内含程序、配置、LuCI、接管脚本，无额外依赖 |
| 🔀 | **DNS 自动接管** | 启动即把 LAN 的 `:53` 交给 dnsmasq，再转发到 AtomDNS `:5335` |
| ↩️ | **可逆恢复** | 停止服务自动还原 dnsmasq 配置并删除接管规则，断网风险为零 |
| 🛡 | **失败安全** | 进程/端口没起来时不接管，保持原 DNS 不变 |
| 🖥 | **LuCI 控制台** | 状态、PID、内存、版本、接管开关、端口/模式/SOCKS 高级设置 |
| 📜 | **内置日志** | 中文标注 + 按来源/级别细分，不跳转系统日志页 |
| 🚀 | **代理友好** | 默认 RealIP，国外 DoH 经 HomeProxy/sing-box 的 TUN 自动代理 |
| 🔁 | **开机守卫** | 禁用自启后重启，也会自动还原 dnsmasq，不会留下坏配置 |
| 🧪 | **CI 构建** | GitHub Actions：rustup 编译 → OpenWrt SDK 打包 → 自动发布 Release |

## 🚀 快速开始

### 1. 安装

从 [Releases](https://github.com/LianXia233/atomdns-openwrt/releases) 下载 `atomdns-1.0.0-r1.apk`：

```sh
scp atomdns-1.0.0-r1.apk root@<router>:/tmp/
ssh root@<router>
apk add --allow-untrusted /tmp/atomdns-1.0.0-r1.apk
```

> 自建包没有签名索引，必须带 `--allow-untrusted`。

安装完成后：

- DNS：`<router>:5335`（UDP/TCP）
- WebUI：`http://<router>:9099/`
- LuCI：**服务 → AtomDNS**
- 配置目录：`/etc/atomdns/`

### 2. 让 dnsmasq 转发给 AtomDNS

```sh
uci set dhcp.@dnsmasq[0].noresolv='1'
uci -q delete dhcp.@dnsmasq[0].server
uci add_list dhcp.@dnsmasq[0].server='127.0.0.1#5335'
uci commit dhcp
/etc/init.d/dnsmasq restart
```

> 服务启动时也会自动做同样的事（含回滚快照），手动执行只是为了初始化确认。

## 🧠 DNS 接管原理

很多路由器上 HomeProxy/sing-box 会抢先劫持 LAN 的 53 端口：

```text
sing-box prerouting_prematch   priority dstnat - 1
sing-box prerouting            priority dstnat + 2   → LAN :53 DNAT 到 TUN
dnsmasq prerouting             priority dstnat + 5   （被压在后面）
```

所以只改 dnsmasq 上游并不生效。本包在更早的位置插入自己的 nat 链：

```text
table inet atomdns
└── chain prerouting          priority dstnat - 10
    ├── iifname br-lan udp dport 53 redirect to :53
    └── iifname br-lan tcp dport 53 redirect to :53
```

```text
LAN 客户端 ──:53──▶ dnsmasq（本地 DHCP 名字）
                        │
                        └──▶ 127.0.0.1:5335 AtomDNS
                                  ├── 国内：DoH 阿里（直连）
                                  └── 国外：DoH Google/Cloudflare（经 sing-box 代理）
```

- 原 `noresolv` / `server` 快照保存在 `/etc/atomdns/dns-takeover.state`；
- 停止服务时删表、还原快照，LAN 立即回到 HomeProxy 的 DNS；
- 生命周期与失败安全：

| 操作 | 行为 |
| --- | --- |
| `start` / 开机 | 等进程和端口就绪后接管；失败则不改 DNS |
| `stop` | 删除 nft 表、还原 dnsmasq |
| `restart` | 先还原再接管（幂等） |
| `disable` + `stop` | 停止并还原，重启后不再接管 |
| 禁用自启后重启 | `atomdns-recover` 自动还原 |
| 卸载 | `prerm` 先还原再停止 |

## 🖥 LuCI 页面

**服务 → AtomDNS**（纯 JS 视图 + rpcd ACL，不使用 Lua）：

- **服务状态**：运行中/已停止、PID、运行时长、内存/线程、程序/WebUI 版本；
- **DNS 接管**：已接管/未接管、`LAN :53 → dnsmasq → AtomDNS`；
- **配置 schema**：读 `/api/v1/system/health`，全新安装显示“程序要求 7，已应用 0”；
- **日志**：分四块——接管与服务 / 应用错误 / 应用警告 / 应用信息，
  级别和来源用中文标注（如 `01:38:07 [错误] DNS 接管 · …`），日志正文保持原文；
- **操作**：启动 / 停止 / 重启 / 停止并禁用自启 / 打开 WebUI；
- **高级设置**：立即接管、取消接管、DNS 端口、RealIP/FakeIP、SOCKS5、保存并重启。

> 保存配置时先备份、写后跑 `atomdns check` 校验，失败自动回滚；并发保存已串行化。

## 🛠 构建

### CI（推荐）

`.github/workflows/build.yml` 在 **tag `v*`** 或手动触发时运行：

1. **rustup** 安装 Rust `1.96.0` + `aarch64-unknown-linux-musl`；
2. `pip install ziglang cargo-zigbuild`，交叉编译 AtomDNS 源码（校验上游 tarball sha256）；
3. 下载上游 `config_rust.zip`（校验 sha256），`build-bundle.sh` 组装源包；
4. 下载 OpenWrt **apk** SDK（mediatek/filogic，snapshot），只执行
   `make package/atomdns/compile`；
5. 校验 apk 的 `arch=aarch64_cortex-a53` 与版本号，上传 artifact；
6. tag 构建时自动 `gh release create`，附上 `.apk` 与 `SHA256SUMS`。

### 本地

```sh
# 0) 需要：官方 Rust 工具链、zig、cargo-zigbuild、OpenWrt apk SDK
rustup target add aarch64-unknown-linux-musl
pip install ziglang cargo-zigbuild

# 1) 编译静态二进制（上游源码 v0.6.6；ATOMDNS_BUILD_VERSION 决定程序版本号）
curl -LO https://github.com/jasonxtt/atomdns/archive/refs/tags/v0.6.6.tar.gz
tar -xzf v0.6.6.tar.gz && cd atomdns-0.6.6
ATOMDNS_BUILD_VERSION=v1.0.0 cargo zigbuild --locked \
  -p atomdns-native-host --release --target aarch64-unknown-linux-musl
tar -C rust/target/aarch64-unknown-linux-musl/release \
  --owner=0 --group=0 --numeric-owner -czf /tmp/atomdns-linux-arm64.tar.gz atomdns
cd -

# 2) 组装源包（版本号写进包名与 WebUI 清单）
VERSION=1.0.0 ./build-bundle.sh /tmp/atomdns-linux-arm64.tar.gz \
  /path/to/config_rust.zip dist

# 3) 填 PKG_HASH，进 SDK 打包
sed -i "s|^PKG_HASH:=.*|PKG_HASH:=$(sha256sum dist/atomdns-openwrt-1.0.0-aarch64.tar.gz | cut -d' ' -f1)|" Makefile
mkdir -p <sdk>/package/atomdns && cp Makefile <sdk>/package/atomdns/
cp dist/atomdns-openwrt-1.0.0-aarch64.tar.gz <sdk>/dl/
cd <sdk> && make defconfig && make package/atomdns/compile V=s
```

## 📦 发布

| 资产 | 说明 |
| --- | --- |
| `atomdns-1.0.0-r1.apk` | 单包（程序 + 配置 + LuCI + 接管脚本） |
| `SHA256SUMS` | 校验和 |

版本策略：`vX.Y.Z` 为打包发布版本；内置 AtomDNS 程序版本由
`ATOMDNS_BUILD_VERSION` 注入，WebUI 清单同步为该版本。上游源码固定为 `v0.6.6`。

## ⚠️ 注意

1. **默认 RealIP**：FakeIP 需要本机 6666/1053 的 FakeIP 上游，没有时不要切回 fakeip。
2. **WebUI/API 无认证**：9099 只应暴露在内网。
3. **端口 5335**：5353 通常被 avahi/mDNS 占用；改端口请用 LuCI 高级设置。
4. `/etc/atomdns/` 在 apk 保护路径内，升级时新默认值会落成 `*.apk-new`，旧配置保留。
5. 在线自更新只支持 x86_64；arm64 升级统一走 apk。
6. SDK 使用 snapshot；若固定文件名轮换，工作流会自动解析当前 snapshot SDK。

## 📄 许可与上游

本仓库的打包脚本、procd 脚本、DNS 接管脚本与 LuCI 视图均为 **GPL-3.0**（见 [LICENSE](LICENSE)）。
AtomDNS 本体版权归 [jasonxtt/atomdns](https://github.com/jasonxtt/atomdns)（GPL-3.0）；
本仓库不直接分发上游源码，CI 在构建时按固定 tag 与 sha256 拉取。
