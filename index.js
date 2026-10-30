/**
 * `@local/dsh-web-fetch-fakeip`: a second `ctx.web` fetch provider that tolerates
 * locally-mapped DNS answers (fake-ip) instead of rejecting them.
 *
 * The shipped `@deepseek-ai/dsh-web-fetch-http` provider rejects a hostname when
 * any resolved address is not public unicast, so a DNS fake-ip implementation
 * (Clash, sing-box, Surge — all answer in a reserved block such as
 * 198.18.0.0/15) makes `web_fetch` fail with `WEB_BLOCKED_URL`.
 *
 * This provider keeps the same retrieval contract and replaces only the address
 * decision: an address inside `allowCidrs` is accepted, any other address must
 * still be public unicast. It registers under its own id, so it never collides
 * with the shipped `http` provider. Select it with `fetchProvider: http-fakeip`
 * on `@deepseek-ai/dsh-web`, or set `DSH_WEB_FETCH_PROVIDER=http-fakeip`.
 *
 * The module deliberately imports nothing from the harness: a profile-installed
 * bundle cannot resolve the runtime's `@deepseek-ai/*` packages (the registry
 * copies are published at 0.0.1-rc.x, far behind the running kernel).
 *
 * @module @local/dsh-web-fetch-fakeip
 */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

import { addressInRange, isPublicAddress, parseCidr, stripBrackets } from './lib/classify.js'

/** Provider id this plugin registers under; never `http`. */
export const FAKE_IP_PROVIDER_ID = 'http-fakeip'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-fetch-fakeip'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Default `User-Agent`, matching the shipped provider. */
export const DEFAULT_USER_AGENT = 'deepseek-harness/0.0.1 (+https://github.com/deepseek-ai)'

/** Maximum accepted URL length, matching the shipped provider. */
const MAX_URL_LENGTH = 2048

/** Redirect statuses that end a hop. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/** Defaults applied when the plugin row omits a field. */
export const DEFAULTS = {
  allowCidrs: [],
  maxResponseBytes: 5_000_000,
  maxBodyChars: 100_000,
  timeoutMs: 30_000,
  maxRedirects: 5,
  userAgent: DEFAULT_USER_AGENT,
}

/**
 * Build an error that carries the harness' machine-routable `code`. The runtime's
 * `WebError` class cannot be imported from a profile-installed bundle, so the
 * name and code are set on a plain `Error` instead.
 *
 * @param {string} message - human readable reason.
 * @param {string} code - `WEB_*` code the harness surfaces to the model.
 * @returns {Error} the tagged error.
 */
function webError(message, code) {
  const error = new Error(message)
  error.name = 'WebError'
  error.code = code
  return error
}

/**
 * Parse and check a request URL.
 *
 * @param {string} input - raw URL.
 * @returns {URL} the parsed URL.
 */
function parseFetchUrl(input) {
  if (typeof input !== 'string' || input.length > MAX_URL_LENGTH) {
    throw webError(`URL exceeds the maximum length of ${MAX_URL_LENGTH}`, 'WEB_INVALID_URL')
  }
  let url
  try {
    url = new URL(input)
  } catch {
    throw webError(`invalid URL: ${input}`, 'WEB_INVALID_URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw webError(`unsupported URL scheme "${url.protocol}" (only http and https are allowed)`, 'WEB_INVALID_URL')
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw webError('credentials in URLs are not allowed', 'WEB_BLOCKED_URL')
  }
  return url
}

/**
 * Whether two URLs share scheme, hostname, and port. Cross-origin redirects are
 * refused so each new origin needs a fresh tool call and a fresh decision.
 *
 * @param {URL} a - first URL.
 * @param {URL} b - second URL.
 * @returns {boolean} true when both URLs are same-origin.
 */
function isSameOrigin(a, b) {
  return a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port
}

/**
 * Classify a `Content-Type` header into the body kind this provider decodes.
 *
 * @param {string|null} header - raw `Content-Type` value.
 * @returns {'html'|'text'|undefined} the kind, or undefined for unsupported types.
 */
function classifyContentType(header) {
  if (header === null || header === '') return 'html'
  const type = header.split(';')[0].trim().toLowerCase()
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html'
  if (type.startsWith('text/')) return 'text'
  if (type === 'application/json' || type.endsWith('+json')) return 'text'
  if (type === 'application/xml' || type.endsWith('+xml')) return 'text'
  if (type === 'application/x-ndjson') return 'text'
  return undefined
}

/**
 * Read the charset parameter out of a `Content-Type` header.
 *
 * @param {string|null} header - raw `Content-Type` value.
 * @returns {string} the charset label, UTF-8 when absent.
 */
function charsetOf(header) {
  if (header === null) return 'utf-8'
  const match = /;\s*charset\s*=\s*"?([^";\s]+)"?/iu.exec(header)
  return match === null ? 'utf-8' : match[1]
}

/**
 * Decode response bytes with the declared charset.
 *
 * @param {Uint8Array} bytes - response body bytes.
 * @param {string} charset - charset label from the response header.
 * @returns {string} the decoded body.
 */
function decodeBody(bytes, charset) {
  try {
    return new TextDecoder(charset).decode(bytes)
  } catch {
    throw webError(`unsupported response charset "${charset}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE')
  }
}

/**
 * Race a promise against an abort signal.
 *
 * @template T
 * @param {Promise<T>} promise - in-flight work.
 * @param {AbortSignal} [signal] - cancellation signal.
 * @returns {Promise<T>} the promise result unless the signal aborts first.
 */
function raceWithSignal(promise, signal) {
  if (signal === undefined) return promise
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(webError('web fetch aborted', 'WEB_ABORTED'))
      return
    }
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(webError('web fetch aborted', 'WEB_ABORTED'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/**
 * Resolve a hostname and decide whether it may be dialled: inside the allow list,
 * or public unicast.
 *
 * @param {string} hostname - URL hostname, possibly bracketed.
 * @param {AbortSignal} [signal] - cancellation signal.
 * @param {Array<{ family: number, bits: number, base: bigint }>} ranges - parsed allow-list blocks.
 * @returns {Promise<string[]>} the accepted addresses.
 */
export async function resolveAllowedAddresses(hostname, signal, ranges) {
  const host = stripBrackets(hostname)
  const literalFamily = isIP(host)
  const addresses =
    literalFamily === 0
      ? await raceWithSignal(lookup(host, { all: true, order: 'verbatim' }), signal)
      : [{ address: host, family: literalFamily }]

  if (addresses.length === 0) {
    throw webError(`hostname "${hostname}" resolved to no addresses`, 'WEB_PROVIDER_ERROR')
  }
  for (const entry of addresses) {
    if (ranges.some((range) => addressInRange(entry.address, range))) continue
    if (!isPublicAddress(entry.address)) {
      throw webError(`URL hostname "${hostname}" resolves to a non-public IP address`, 'WEB_BLOCKED_URL')
    }
  }
  return addresses.map((entry) => entry.address)
}

/**
 * Read a response body with a byte cap.
 *
 * @param {Response} response - the response to drain.
 * @param {{ maxResponseBytes: number }} limits - byte cap.
 * @returns {Promise<{ bytes: Uint8Array, truncated: boolean }>} capped bytes.
 */
async function readCappedBytes(response, limits) {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limits.maxResponseBytes) {
    throw webError(`response exceeds the maximum of ${limits.maxResponseBytes} bytes`, 'WEB_FETCH_TOO_LARGE')
  }
  if (response.body === null) return { bytes: new Uint8Array(0), truncated: false }

  const chunks = []
  let total = 0
  let truncated = false
  for await (const chunk of response.body) {
    if (total + chunk.byteLength > limits.maxResponseBytes) {
      const room = limits.maxResponseBytes - total
      if (room > 0) chunks.push(chunk.subarray(0, room))
      total = limits.maxResponseBytes
      truncated = true
      break
    }
    chunks.push(chunk)
    total += chunk.byteLength
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes, truncated }
}

/** The fake-ip tolerant HTTP(S) fetch provider. */
export class FakeIpAwareFetchProvider {
  /**
   * @param {object} limits - resolved transport and response limits.
   * @param {Array<{ family: number, bits: number, base: bigint }>} ranges - parsed allow-list blocks.
   */
  constructor(limits, ranges) {
    this.id = FAKE_IP_PROVIDER_ID
    this.limits = limits
    this.ranges = ranges
  }

  /** No credentials to check — an anonymous fetcher is always usable. */
  available() {
    return true
  }

  /**
   * Retrieve one URL.
   *
   * @param {{ url: string }} request - the fetch request.
   * @param {AbortSignal} [signal] - cancellation signal.
   * @returns {Promise<{ url: string, statusCode: number, body: { kind: 'html'|'text', content: string }, truncated: boolean }>}
   */
  async fetch(request, signal) {
    const timeout = AbortSignal.timeout(this.limits.timeoutMs)
    const composed = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    try {
      let current = parseFetchUrl(request.url)
      let redirects = 0
      for (;;) {
        await resolveAllowedAddresses(current.hostname, composed, this.ranges)
        const response = await fetch(current, {
          method: 'GET',
          redirect: 'manual',
          signal: composed,
          headers: {
            'user-agent': this.limits.userAgent,
            accept: 'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8',
          },
        })

        if (REDIRECT_STATUSES.has(response.status)) {
          const location = response.headers.get('location')
          await response.body?.cancel()
          if (location === null) return this.result(current, response, new Uint8Array(0), false)
          if (redirects >= this.limits.maxRedirects) {
            throw webError(`exceeded the maximum of ${this.limits.maxRedirects} redirects`, 'WEB_REDIRECT_BLOCKED')
          }
          const next = new URL(location, current)
          if (!isSameOrigin(next, current)) {
            throw webError(`redirect from "${current.origin}" to "${next.origin}" crosses origins`, 'WEB_REDIRECT_BLOCKED')
          }
          redirects += 1
          current = next
          continue
        }

        const header = response.headers.get('content-type')
        const kind = classifyContentType(header)
        if (kind === undefined) {
          await response.body?.cancel()
          throw webError(`unsupported content type "${header}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE')
        }

        const { bytes, truncated } = await readCappedBytes(response, this.limits)
        return this.result(current, response, bytes, truncated, kind, charsetOf(header))
      }
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw webError('web fetch timed out or was aborted', signal?.aborted === true ? 'WEB_ABORTED' : 'WEB_FETCH_TIMEOUT')
      }
      if (error?.name === 'WebError') throw error
      throw webError(`fetch failed: ${error?.message ?? error}`, 'WEB_PROVIDER_ERROR')
    }
  }

  /**
   * Assemble the provider result.
   *
   * @param {URL} url - final URL.
   * @param {Response} response - the HTTP response.
   * @param {Uint8Array} bytes - capped body bytes.
   * @param {boolean} truncatedByBytes - whether the byte cap clipped the body.
   * @param {'html'|'text'} [kind] - body kind, defaults to `html`.
   * @param {string} [charset] - charset label, defaults to UTF-8.
   * @returns {object} the `WebFetchResult`.
   */
  result(url, response, bytes, truncatedByBytes, kind = 'html', charset = 'utf-8') {
    let content = decodeBody(bytes, charset)
    let truncatedByChars = false
    if (content.length > this.limits.maxBodyChars) {
      content = content.slice(0, this.limits.maxBodyChars)
      truncatedByChars = true
    }
    return {
      url: url.href,
      statusCode: response.status,
      body: kind === 'html' ? { kind: 'html', content } : { kind: 'text', content },
      truncated: truncatedByBytes || truncatedByChars,
    }
  }
}

/**
 * Register the fake-ip tolerant HTTP(S) fetch provider with `ctx.web`.
 *
 * @param {{ web: { registerFetchProvider(provider: unknown): () => void } }} ctx - plugin context.
 * @param {object} [config] - the plugin row's `config`.
 */
export function apply(ctx, config) {
  const resolved = { ...DEFAULTS, ...(config ?? {}) }
  if (!Array.isArray(resolved.allowCidrs)) {
    throw new Error('web-fetch-fakeip: allowCidrs must be an array of CIDR strings')
  }
  for (const key of ['maxResponseBytes', 'maxBodyChars', 'timeoutMs']) {
    if (!Number.isFinite(resolved[key]) || resolved[key] <= 0) {
      throw new Error(`web-fetch-fakeip: ${key} must be a positive finite number`)
    }
  }
  if (!Number.isInteger(resolved.maxRedirects) || resolved.maxRedirects < 0) {
    throw new Error('web-fetch-fakeip: maxRedirects must be a non-negative integer')
  }

  // Parse once at activation so a typo fails loudly instead of at fetch time.
  const ranges = resolved.allowCidrs.map((cidr) => parseCidr(cidr))
  const limits = {
    maxResponseBytes: resolved.maxResponseBytes,
    maxBodyChars: resolved.maxBodyChars,
    timeoutMs: resolved.timeoutMs,
    maxRedirects: resolved.maxRedirects,
    userAgent: resolved.userAgent,
  }
  ctx.web.registerFetchProvider(new FakeIpAwareFetchProvider(limits, ranges))
}
