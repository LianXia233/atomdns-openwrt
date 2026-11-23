#!/bin/sh
# 组装 OpenWrt 包的源包（二进制 + 默认配置 + procd 脚本），供 OpenWrt SDK 打包。
#
#   ./build-bundle.sh <atomdns-linux-arm64.tar.gz> <config_rust.zip> [输出目录]
#
# 产出自带架构后缀的 atomdns-openwrt-<version>-aarch64.tar.gz，并打印 sha256，
# 把该值填进 Makefile 的 PKG_HASH，再把文件拷到 SDK 的 dl/ 即可离线编译。
set -eu

BIN_TAR=${1:?需要 atomdns-linux-arm64.tar.gz}
CONF_ZIP=${2:?需要 config_rust.zip}
OUT_DIR=${3:-dist}
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# 包/发布版本号；CI 传 VERSION=<x.y.z>，本地默认 1.0.0
VERSION=${VERSION:-1.0.0}
case "$VERSION" in
	[0-9]*.[0-9]*.[0-9]*) ;;
	*) echo "VERSION 必须是 x.y.z（当前 '$VERSION'）" >&2; exit 1 ;;
esac
NAME="atomdns-openwrt-${VERSION}-aarch64"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/$NAME/config" "$TMP/$NAME/files" "$OUT_DIR"

tar -xzf "$BIN_TAR" -C "$TMP/$NAME" atomdns
chmod 0755 "$TMP/$NAME/atomdns"

# 配置包：README-rust.md 描述的是 Docker/Go 迁移场景，不放进设备配置目录。
unzip -q "$CONF_ZIP" -d "$TMP/conf"
cp -a "$TMP/conf/." "$TMP/$NAME/config/"
rm -f "$TMP/$NAME/config/README-rust.md"
rm -rf "$TMP/$NAME/config/cache" "$TMP/$NAME/config/gen"
mkdir -p "$TMP/$NAME/config/cache" "$TMP/$NAME/config/gen"
: > "$TMP/$NAME/config/cache/.gitkeep"
: > "$TMP/$NAME/config/gen/.gitkeep"

# 53 被 dnsmasq 占用，默认改到 5335；用户可在 WebUI「上游设置」里改回。
sed -i 's/listen: ":53"/listen: ":5335"/g' "$TMP/$NAME/config/config_custom.yaml"
if grep -q 'listen: ":53"' "$TMP/$NAME/config/config_custom.yaml"; then
	echo "错误: 仍有 :53 监听未替换" >&2
	exit 1
fi
grep -n 'listen: ":5335"' "$TMP/$NAME/config/config_custom.yaml"

# 默认运行模式改为 realip：上游默认是 fakeip，但 FakeIP 需要本机 6666/1053 的
# FakeIP 上游；OpenWrt 上通常搭配 HomeProxy/sing-box（真实 IP），用 fakeip
# 会让被代理域名解析失败。用户可在 LuCI 高级设置里改回 fakeip。
awk '
	/- tag:[ \t]*dns_mode/ { inb = 1 }
	inb && /^[ \t]*default:/ { sub(/default:[ \t]*[A-Za-z0-9_]+/, "default: realip"); inb = 0 }
	{ print }
' "$TMP/$NAME/config/sub_config/flags.yaml" > "$TMP/$NAME/config/sub_config/flags.yaml.tmp"
mv "$TMP/$NAME/config/sub_config/flags.yaml.tmp" "$TMP/$NAME/config/sub_config/flags.yaml"
grep -n 'default: realip' "$TMP/$NAME/config/sub_config/flags.yaml" | head -1

# 发布版本号写进 WebUI 清单，避免发布 v1.0.0 时界面仍显示上游 0.6.6。
MANIFEST="$TMP/$NAME/config/ui/main/ui-manifest.json"
if [ -f "$MANIFEST" ]; then
	sed -i 's/"ui_version"[[:space:]]*:[[:space:]]*"[^"]*"/"ui_version": "v'"$VERSION"'"/' "$MANIFEST"
	grep -q "\"ui_version\": \"v$VERSION\"" "$MANIFEST" || {
		echo "错误: ui-manifest.json 版本改写失败" >&2
		exit 1
	}
fi

cp -a "$HERE/files/." "$TMP/$NAME/files/"
chmod 0755 "$TMP/$NAME/files/atomdns.init" \
	"$TMP/$NAME/files/atomdns-recover.init" \
	"$TMP/$NAME/files/atomdns-dnsctl" \
	"$TMP/$NAME/files/atomdns-configctl"
chmod 0644 "$TMP/$NAME/files/protected_paths.list"

# LuCI 页面与主程序同一个包：/www 下的 JS 视图 + menu.d + rpcd ACL。
mkdir -p "$TMP/$NAME/luci"
cp -a "$HERE/luci/htdocs" "$TMP/$NAME/luci/htdocs"
cp -a "$HERE/luci/root" "$TMP/$NAME/luci/root"

# 固定 mtime，保证同样的输入得到同样的包（便于核对 PKG_HASH）。
find "$TMP/$NAME" -exec touch -h -d '2026-11-10 00:00:00 UTC' {} +
tar -C "$TMP" --sort=name --owner=0 --group=0 --numeric-owner \
	-czf "$OUT_DIR/$NAME.tar.gz" "$NAME"

echo "==> $OUT_DIR/$NAME.tar.gz"
sha256sum "$OUT_DIR/$NAME.tar.gz"
