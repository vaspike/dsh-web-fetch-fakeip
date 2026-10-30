# dsh-web-fetch-fakeip

[English](README.md) | 中文

一个 DeepSeek Harness 插件，让 `web_fetch` 在 DNS **fake-ip** 环境（Clash、sing-box、Surge……）下正常工作。

官方内置的 `@deepseek-ai/dsh-web-fetch-http` provider 只要发现解析结果里有任何一个地址不是公网单播，就会拒绝这个主机名。fake-ip 会给每个域名都返回保留网段里的地址——默认是 `198.18.0.0/15`——所以每次 `web_fetch` 都会失败：

```
URL hostname "github.com" resolves to a non-public IP address   (WEB_BLOCKED_URL)
```

本插件注册第二个抓取 provider `http-fakeip`，保持同样的抓取契约，只改动地址判定这一步：落在 `allowCidrs` 里的地址直接放行，其余地址仍然必须是公网单播。回环、RFC 1918、链路本地、CGNAT 以及其他保留网段照样拦截。

## 安装

```sh
dsh plugin --profile <你的-profile> add https://github.com/vaspike/dsh-web-fetch-fakeip
```

或者从本地检出目录安装，把 `plugin_manager` 指向该目录：

```
plugin_manager action=install_bundle target=/path/to/dsh-web-fetch-fakeip
```

bundle 指在 `package.json` 里声明了 `dsh.bundle.patch` 的包，被选中之后下面的 patch 才会被应用。

bundle 的 patch 做两件事：

1. 插入 `web-fetch-fakeip` 这一行；
2. 把 `@deepseek-ai/dsh-web` 钉到它上面（`fetchProvider: http-fakeip`）。

因为这种覆盖式 patch 会**整段替换** `web` 的 config，所以这里把官方的 `searchProvider` 值也重复写了一遍。如果你的 profile 在别处自定义了 `searchProvider`（或 `fetchProvider`），请把两个键都写在应当生效的那一层——用户层（`cordis.patch.yml`）在 bundle 之后应用，因此它优先。

## 配置

```yaml
- id: web-fetch-fakeip
  name: 'dsh-web-fetch-fakeip'
  config:
    allowCidrs:
      - 198.18.0.0/15   # Clash / sing-box / Surge 的 fake-ip 默认网段
    maxResponseBytes: 5000000
    maxBodyChars: 100000
    timeoutMs: 30000
    maxRedirects: 5
```

`allowCidrs` 默认是 `[]`，此时行为与官方 provider 完全一致。所有网段在激活时解析，写错会直接报错，而不是等到抓取时才失败。

## 验证

```bash
node --test test/classify.test.js
```

分类器零依赖并有单元测试覆盖：地址解析、CIDR 匹配，以及 v4/v6 两个地址族的公网/保留判定，包含 `::ffff:` 映射地址。

## 限制

- **先校验后抓取。** 请求发出前会校验地址集合，但请求本身走的是全局 `fetch`，会再解析一次。这里没有做 DNS 固定（pinning），所以一个会重绑定的解析器有可能通过校验后连到别处。官方 provider 会把连接钉住；为了在 profile 安装的 bundle 里保持零 import，这里放弃了这一点。
- **只跟随同源重定向**，只解码 `text/*` 与 JSON/XML，字符集取自 `Content-Type`——与官方 provider 同一套契约。
- **没有 `WebError` 类。** 运行时的这个类无法从 profile 安装的 bundle 里 import，所以错误对象带 `name = 'WebError'` 和同样的 `WEB_*` 错误码，但 `instanceof` 判断会失败。harness 对外暴露的是错误码。
- **依赖官方 provider 保持"唯一"这件事。** 如果将来内核给 `dsh-web-fetch-http` 加上了 `ssrfAllowCidrs` 之类的配置项，删掉这个 bundle，直接用那个即可。
