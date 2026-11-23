#!/usr/bin/env python3
"""Upload one local file to a router over SFTP (paramiko)."""
import os
import sys

import paramiko

host = os.environ.get("ROUTER_HOST")
port = int(os.environ.get("ROUTER_PORT", "22"))
user = os.environ.get("ROUTER_USER", "root")
pwd = os.environ.get("ROUTER_PASS")

if not host or pwd is None:
    print("set ROUTER_HOST and ROUTER_PASS first")
    sys.exit(1)

if len(sys.argv) < 3:
    print("usage: sftp_put.py <local> <remote>")
    sys.exit(1)

local, remote = sys.argv[1], sys.argv[2]
c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(host, port=port, username=user, password=pwd,
          timeout=15, allow_agent=False, look_for_keys=False)
try:
    sftp = c.open_sftp()
    remote_dir = remote.rsplit("/", 1)[0]
    try:
        sftp.stat(remote_dir)
    except IOError:
        sftp.mkdir(remote_dir)
    sftp.put(local, remote)
    print("uploaded %s -> %s (%d bytes)" % (local, remote, sftp.stat(remote).st_size))
    sftp.close()
finally:
    c.close()
