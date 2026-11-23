# AtomDNS for OpenWrt (apk / apk-tools 3, OpenWrt main & ImmortalWrt SNAPSHOT)
#
# 上游发布的就是静态 musl 二进制（arm64 / armv7 / amd64），所以这里不编译 Rust，
# 只把「二进制 + 默认配置包 + procd 启动脚本」打成一个 apk。
#
# 用法（详见 README.md）：
#   cp atomdns-openwrt-0.6.6-aarch64.tar.gz  <sdk>/dl/
#   cp -r openwrt-atomdns <sdk>/package/atomdns
#   cd <sdk> && make package/atomdns/compile V=s

include $(TOPDIR)/rules.mk

PKG_NAME:=atomdns
PKG_VERSION:=0.6.6
PKG_RELEASE:=14

PKG_LICENSE:=GPL-3.0-only
PKG_MAINTAINER:=jasonxtt <https://github.com/jasonxtt/atomdns>

# 预编译包：由 build-bundle.sh 生成，放进 SDK 的 dl/ 后不会联网下载。
# 注意 PKG_SOURCE 的架构后缀必须与实际二进制一致（当前为 aarch64）。
PKG_SOURCE:=atomdns-openwrt-$(PKG_VERSION)-aarch64.tar.gz
PKG_SOURCE_URL:=https://github.com/jasonxtt/atomdns/releases/download/v$(PKG_VERSION)
PKG_HASH:=a41ac9063a713c5f7a3a635859c584205cc14eb556313b55b50dca206e76d8f5
PKG_BUILD_DIR:=$(BUILD_DIR)/atomdns-openwrt-$(PKG_VERSION)-aarch64

include $(INCLUDE_DIR)/package.mk

define Package/atomdns
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=DNS
  TITLE:=MosDNS-compatible DNS splitter and cache (Rust, static)
  URL:=https://github.com/jasonxtt/atomdns
  # DoH / DoT 上游与在线规则下载要走系统根证书（rustls-native-certs）。
  DEPENDS:=+ca-bundle
endef

define Package/atomdns/description
 AtomDNS is a pure-Rust reimplementation of MosDNS with a WebUI, dedicated
 routing groups, route learning, online rule subscriptions and query audit.
 This package ships the upstream static musl binary, a ready-to-run
 configuration rooted at /etc/atomdns and the LuCI overview page
 (Services -> AtomDNS, JavaScript view). Starting the service takes over DNS
 for the LAN (LAN :53 -> dnsmasq -> AtomDNS); stopping it restores the
 original dnsmasq settings and removes the takeover rules.
endef

define Build/Compile
endef

define Package/atomdns/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/atomdns $(1)/usr/bin/atomdns
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/files/atomdns.init $(1)/etc/init.d/atomdns
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/files/atomdns-recover.init $(1)/etc/init.d/atomdns-recover
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/files/atomdns-dnsctl $(1)/usr/bin/atomdns-dnsctl
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/files/atomdns-configctl $(1)/usr/bin/atomdns-configctl
	$(INSTALL_DIR) $(1)/etc/apk/protected_paths.d
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/files/protected_paths.list $(1)/etc/apk/protected_paths.d/atomdns.list
	$(INSTALL_DIR) $(1)/etc/atomdns
	$(CP) $(PKG_BUILD_DIR)/config/. $(1)/etc/atomdns/
	$(INSTALL_DIR) $(1)/etc/atomdns/cache $(1)/etc/atomdns/gen
	# 同一个包内置 LuCI 页面（纯 JS 视图，无 Lua CBI）
	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/atomdns
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/luci/htdocs/luci-static/resources/view/atomdns/overview.js \
		$(1)/www/luci-static/resources/view/atomdns/overview.js
	$(INSTALL_DIR) $(1)/usr/share/luci/menu.d
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/luci/root/usr/share/luci/menu.d/luci-app-atomdns.json \
		$(1)/usr/share/luci/menu.d/luci-app-atomdns.json
	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/luci/root/usr/share/rpcd/acl.d/luci-app-atomdns.json \
		$(1)/usr/share/rpcd/acl.d/luci-app-atomdns.json
endef

define Package/atomdns/conffiles
/etc/atomdns/config_custom.yaml
/etc/atomdns/sub_config/settings.yaml
/etc/atomdns/sub_config/flags.yaml
endef

define Package/atomdns/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] && exit 0
/etc/init.d/atomdns-recover enable
/etc/init.d/atomdns enable
/etc/init.d/atomdns restart
# 新装的 menu.d / acl.d 需要清缓存并让 rpcd 重新加载 ACL
rm -rf /tmp/luci-modulecache /tmp/luci-indexcache*
/etc/init.d/rpcd restart 2>/dev/null
echo "atomdns: 已启动并接管 DNS（LAN -> dnsmasq -> AtomDNS），WebUI http://<router>:9099/"
echo "atomdns: LuCI 页面在「服务 → AtomDNS」，高级设置里可改端口/模式/SOCKS 或取消接管"
echo "atomdns: 停止服务会自动恢复原 dnsmasq 配置"
exit 0
endef

define Package/atomdns/prerm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] && exit 0
/usr/bin/atomdns-dnsctl restore >/dev/null 2>&1
/etc/init.d/atomdns stop
/etc/init.d/atomdns disable
/etc/init.d/atomdns-recover disable
exit 0
endef

$(eval $(call BuildPackage,atomdns))
