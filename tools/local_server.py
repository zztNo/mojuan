#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""墨卷本地服务器：静态托管 + 网页代理。

为什么需要它：浏览器有 CORS 限制，网页前端不能直接读取别人的站点。
这个脚本跑在你自己机器上，浏览器访问它（同源），再由它去取网页，
就不受 CORS 限制了。内容只经过你自己的电脑，不经过任何第三方服务器。

法律边界（重要）：
  这是一个中立的网页转发工具，和你用浏览器打开网页没有本质区别。
  它不内置、不分发、不推荐任何书源，也不抓取任何网站的内容给你。
  它只转发"你明确指定地址的网页"，取回什么、用来做什么，完全由你决定。
  请只访问你自己有权访问的公开或授权内容，勿用于侵犯他人版权。

用法：
  python tools/local_server.py              # 默认 127.0.0.1:8899
  python tools/local_server.py 9000         # 换端口
  然后浏览器打开 http://127.0.0.1:8899/
  在墨卷「墨斋 → 书源 → 代理地址」里填 http://127.0.0.1:8899 即可。

只监听 127.0.0.1，不对外网开放；按 Ctrl+C 停止。
"""
import sys
import os
import re
import json
import urllib.request
import urllib.error
import urllib.parse
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from functools import partial

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAX_BYTES = 8 * 1024 * 1024   # 单页最多 8MB，防止把超大文件读爆内存
TIMEOUT = 20                  # 秒
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36')


def decode_body(raw, content_type):
    """按响应头 charset 优先解码，否则 UTF-8 严格模式试，失败退回 gb18030。
    中文小说站大量是 GBK，这一步必须有。"""
    m = re.search(r'charset\s*=\s*["\']?\s*([\w-]+)', content_type or '', re.I)
    if m:
        enc = m.group(1).lower()
        if enc in ('gb2312', 'gbk'):
            enc = 'gb18030'
        try:
            return raw.decode(enc)
        except (UnicodeDecodeError, LookupError):
            pass
    try:
        return raw.decode('utf-8')
    except UnicodeDecodeError:
        try:
            return raw.decode('gb18030')
        except UnicodeDecodeError:
            return raw.decode('utf-8', errors='replace')


class MojuanHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == '/proxy':
            self.handle_proxy(parsed)
        else:
            super().do_GET()

    def handle_proxy(self, parsed):
        qs = urllib.parse.parse_qs(parsed.query)
        target = (qs.get('url') or [''])[0].strip()
        if not target:
            self._json(400, {'error': '缺少 url 参数'})
            return
        if not re.match(r'^https?://', target, re.I):
            self._json(400, {'error': '只支持 http/https 地址'})
            return
        try:
            req = urllib.request.Request(target, headers={
                'User-Agent': UA,
                'Accept': 'text/html,application/xhtml+xml,application/json,*/*',
                'Accept-Language': 'zh-CN,zh;q=0.9',
            })
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                ctype = resp.headers.get('Content-Type', '')
                raw = resp.read(MAX_BYTES + 1)
                if len(raw) > MAX_BYTES:
                    self._json(413, {'error': '页面超过 8MB，已截断保护'})
                    return
                final_url = resp.geturl()
                status = resp.status
            text = decode_body(raw, ctype)
            sys.stderr.write('[proxy] -> %s | %d bytes | %s\n' % (
                final_url, len(text), text[:30].replace('\n', ' ')))
            self._json(200, {'text': text, 'url': final_url, 'status': status})
        except urllib.error.HTTPError as e:
            self._json(502, {'error': '目标站返回 HTTP ' + str(e.code), 'status': e.code})
        except Exception as e:
            self._json(502, {'error': '取回失败：' + (str(e) or e.__class__.__name__)})

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        # 代理结果不缓存：同一个 /proxy 地址每次都要取目标站最新内容
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        # 加 CORS 头，方便把代理单独部署到别的地址时用；同源访问不需要
        self.send_header('Access-Control-Allow-Origin', '*')
        # 明确关闭连接：避免浏览器 keep-alive 复用时响应体错位
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        # 只打印代理请求，静态资源的访问日志太吵
        if '/proxy' in (self.path or ''):
            sys.stderr.write('[proxy] %s\n' % (self.path[:160]))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
    handler = partial(MojuanHandler, directory=ROOT)
    srv = ThreadingHTTPServer(('127.0.0.1', port), handler)
    print('墨卷本地服务器已启动')
    print('  阅读地址: http://127.0.0.1:%d/' % port)
    print('  代理接口: http://127.0.0.1:%d/proxy?url=<目标网页>' % port)
    print('  只监听本机，Ctrl+C 停止')
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止')
    finally:
        srv.server_close()


if __name__ == '__main__':
    main()
