# dsh-web-fetch-fakeip

English | [中文](README.zh.md)

A DeepSeek Harness bundle that makes `web_fetch` work behind a DNS **fake-ip**
implementation (Clash, sing-box, Surge, …).

The shipped `@deepseek-ai/dsh-web-fetch-http` provider rejects a hostname when any
resolved address is not public unicast. Fake-ip answers every name with an address
from a reserved block — `198.18.0.0/15` by default — so every `web_fetch` call
fails with:

```
URL hostname "github.com" resolves to a non-public IP address   (WEB_BLOCKED_URL)
```

This bundle registers a second fetch provider, `http-fakeip`, that keeps the same
retrieval contract and changes only the address decision: an address inside
`allowCidrs` is accepted, any other address must still be public unicast. Loopback,
RFC 1918, link-local, CGNAT and the other reserved blocks stay blocked.

## Install

```sh
dsh plugin --profile <your-profile> add https://github.com/vaspike/dsh-web-fetch-fakeip
```

Or, from a local checkout, point `plugin_manager` at the directory:

```
plugin_manager action=install_bundle target=/path/to/dsh-web-fetch-fakeip
```

A bundle is a package whose `package.json` declares `dsh.bundle.patch`, so the patch
below is applied when the bundle is selected for the profile.

The bundle patch does two things:

1. inserts the `web-fetch-fakeip` row;
2. pins `@deepseek-ai/dsh-web` to it with `fetchProvider: http-fakeip`.

Because a compensating override replaces the **complete** `web` config, the patch
repeats the shipped `searchProvider` value. If your profile customizes
`searchProvider` (or `fetchProvider`) elsewhere, keep both keys in whichever layer
should win — the user layer (`cordis.patch.yml`) is applied after bundles.

## Configure

```yaml
- id: web-fetch-fakeip
  name: 'dsh-web-fetch-fakeip'
  config:
    allowCidrs:
      - 198.18.0.0/15   # Clash / sing-box / Surge fake-ip default
    maxResponseBytes: 5000000
    maxBodyChars: 100000
    timeoutMs: 30000
    maxRedirects: 5
```

`allowCidrs` defaults to `[]`, which makes the provider behave exactly like the
shipped one. Blocks are parsed at activation, so a typo fails loudly.

## Verify

```bash
node --test test/classify.test.js
```

The classifier is dependency-free and unit tested: parsing, CIDR matching, and the
public/reserved decision for both families, including `::ffff:` mapped addresses.

## Limits

- **Validate-then-fetch.** The address set is checked before the request, but the
  request itself goes through the global `fetch`, which resolves again. There is no
  DNS pinning, so a rebinding resolver could pass validation and then connect
  elsewhere. The shipped provider pins the connection; this one trades that away to
  stay import-free inside a profile-installed bundle.
- **Same-origin redirects only**, `text/*` and JSON/XML only, charset taken from
  `Content-Type` — the same contract as the shipped provider.
- **No `WebError` class.** The runtime's class cannot be imported from a profile
  bundle, so errors carry `name = 'WebError'` and the same `WEB_*` codes, but
  `instanceof` checks fail. Codes are what the harness surfaces.
- **Depends on the shipped provider staying the odd one out.** If a future kernel
  adds `ssrfAllowCidrs` to `dsh-web-fetch-http`, delete this bundle and use that.
