/** Real remote browsers with explicit, port-scoped agent-runtime forwarding. */
import { randomUUID } from 'node:crypto';
import type { Browser, BrowserContext, BrowserContextOptions, BrowserType, Page } from 'playwright-core';
import type { BrowserEngine, BrowserIntent, BrowserReceipt } from './browser-runtime.ts';
export type { BrowserEngine, BrowserIntent, BrowserReceipt } from './browser-runtime.ts';
export interface BrowserBootOptions {
  /** Persist this UUID before dispatch. Reuse it after an uncertain boot response. */
  id: string;
  engine?: BrowserEngine;
  ttlSeconds?: number;
  context?: BrowserContextOptions;
  /** Only these ports on 127.0.0.1 are forwarded from the connecting agent. */
  localPorts?: number[];
}
export interface BrowserTab { id: string; url: string }
export interface PageElement {
  selector: string; tag: string; text: string; attributes: Record<string, string>;
  bounds: { x: number; y: number; width: number; height: number }; visible: boolean;
}
export interface ElementSnapshot { url: string; elements: PageElement[]; truncated: boolean }
export class BrowserClient {
  #origin: URL;
  constructor(origin: string, private readonly token: string, private readonly engines: Record<BrowserEngine, Pick<BrowserType, 'connect'>>) {
    this.#origin = new URL(origin);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(this.#origin.hostname);
    if (!(this.#origin.protocol === 'https:' || (local && this.#origin.protocol === 'http:')) || this.#origin.username || this.#origin.password || this.#origin.pathname !== '/' || this.#origin.search || this.#origin.hash) throw new Error('Use HTTPS, or HTTP on loopback, with no path or URL credentials.');
  }
  async #request(method: string, path: string, body?: BrowserIntent): Promise<BrowserReceipt> {
    const response = await fetch(new URL(path, this.#origin), { method, headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(45_000) });
    if (!response.ok) throw new Error(`Browser runtime request failed (${response.status}).`);
    return await response.json() as BrowserReceipt;
  }
  async boot(options: BrowserBootOptions): Promise<BrowserSession> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(options.id)) throw new Error('Persist a browser UUID before boot.');
    const ports = [...new Set(options.localPorts ?? [])];
    if (ports.length > 32 || ports.some(p => !Number.isInteger(p) || p < 1 || p > 65535)) throw new Error('Choose up to 32 explicit local TCP ports.');
    const intent: BrowserIntent = { id: options.id, engine: options.engine ?? 'chromium', ttlSeconds: options.ttlSeconds ?? 300 };
    const receipt = await this.#request('POST', '/v1/browsers', intent);
    const expected = new URL(`/v1/browsers/${options.id}/connect`, this.#origin); expected.protocol = expected.protocol === 'https:' ? 'wss:' : 'ws:';
    if (receipt.id !== options.id || receipt.engine !== intent.engine || receipt.endpoint !== expected.href || typeof receipt.key !== 'string' || !receipt.key) throw new Error('Invalid browser runtime receipt.');
    let browser: Browser | undefined;
    try {
      browser = await this.engines[intent.engine].connect(receipt.endpoint, { headers: { Authorization: `Bearer ${receipt.key}` }, timeout: 30_000, ...(ports.length ? { exposeNetwork: ports.map(p => `127.0.0.1:${p}`).join(',') } : {}) });
      const context = await browser.newContext(options.context);
      context.setDefaultTimeout(15_000); context.setDefaultNavigationTimeout(30_000);
      return new BrowserSession(receipt.id, receipt.expiresAt, browser, context, () => this.stop(options.id));
    } catch (error) {
      await browser?.close().catch(() => {});
      // A failed attachment does not authorize a replacement process or a new boot UUID.
      throw error;
    }
  }
  async stop(id: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid browser ID.');
    await this.#request('DELETE', `/v1/browsers/${id}`);
  }
}
export class BrowserSession {
  #tabs = new Map<string, Page>();
  #active: string | undefined;
  #closed = false;
  constructor(readonly id: string, readonly expiresAt: string, private readonly browser: Browser, readonly context: BrowserContext, private readonly stop: () => Promise<void>) {
    context.on('page', page => this.#register(page));
    for (const page of context.pages()) this.#register(page);
  }
  #register(page: Page): string {
    for (const [id, existing] of this.#tabs) if (existing === page) return id;
    const id = randomUUID(); this.#tabs.set(id, page); this.#active ??= id;
    page.on('close', () => { this.#tabs.delete(id); if (this.#active === id) this.#active = this.#tabs.keys().next().value; });
    return id;
  }
  tabs(): BrowserTab[] { return [...this.#tabs].map(([id, page]) => ({ id, url: page.url() })); }
  get activeTab(): string | undefined { return this.#active; }
  /** Full Playwright page API, including locators, keyboard, frames, uploads and scrolling. */
  page(id = this.#active): Page {
    const page = id ? this.#tabs.get(id) : undefined;
    if (this.#closed || !page || page.isClosed()) throw new Error('Choose an open tab in this browser session.');
    return page;
  }
  async newTab(url?: string): Promise<string> {
    if (this.#closed) throw new Error('Browser session is closed.');
    const page = await this.context.newPage(), id = this.#register(page); this.#active = id;
    if (url) await this.navigate(url, id);
    return id;
  }
  async activateTab(id: string): Promise<void> { await this.page(id).bringToFront(); this.#active = id; }
  async closeTab(id: string): Promise<void> { await this.page(id).close(); }
  async navigate(url: string, tabId = this.#active): Promise<void> {
    const target = new URL(url);
    if (!['http:', 'https:', 'about:'].includes(target.protocol) || target.username || target.password || (target.protocol === 'about:' && url !== 'about:blank')) throw new Error('Use an HTTP(S) URL or about:blank without credentials.');
    await this.page(tabId).goto(url, { waitUntil: 'domcontentloaded' });
  }
  /** Runs JavaScript in the selected page. No automatic retries of uncertain effects. */
  async evaluate(expression: string, tabId = this.#active): Promise<unknown> { return this.page(tabId).evaluate(expression); }
  async screenshot(tabId = this.#active, fullPage = false): Promise<Buffer> { return this.page(tabId).screenshot({ type: 'png', fullPage, timeout: 15_000 }); }
  async click(selector: string, tabId = this.#active): Promise<void> { await this.page(tabId).locator(selector).click(); }
  async clickAt(x: number, y: number, tabId = this.#active): Promise<void> { point(x, y); await this.page(tabId).mouse.click(x, y); }
  async drag(from: { x: number; y: number }, to: { x: number; y: number }, tabId = this.#active): Promise<void> {
    point(from.x, from.y); point(to.x, to.y); const mouse = this.page(tabId).mouse;
    await mouse.move(from.x, from.y);
    try { await mouse.down(); await mouse.move(to.x, to.y, { steps: 20 }); } finally { await mouse.up(); }
  }
  /** Main-document light DOM. Use page().frames()/locators for frames and shadow DOM. */
  async elements(tabId = this.#active, limit = 2000): Promise<ElementSnapshot> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error('Element limit must be between 1 and 10000.');
    return this.page(tabId).evaluate(max => {
      const nodes = document.querySelectorAll('*');
      const elements = Array.from(nodes).slice(0, max).map(element => {
        const parts: string[] = []; let current: Element | null = element;
        while (current) { const tag = current.localName; const siblings: Element[] = current.parentElement ? Array.from(current.parentElement.children).filter(e => e.localName === tag) : [current]; parts.unshift(`${CSS.escape(tag)}:nth-of-type(${siblings.indexOf(current) + 1})`); current = current.parentElement; }
        const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
        return { selector: parts.join(' > '), tag: element.localName, text: ['script', 'style'].includes(element.localName) ? '' : (element.textContent ?? '').slice(0, 500), attributes: Object.fromEntries(Array.from(element.attributes).filter(a => ['id', 'role', 'name', 'type', 'aria-label', 'href', 'title', 'placeholder'].includes(a.name)).map(a => [a.name, a.value.slice(0, 500)])), bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility === 'visible' };
      });
      return { url: location.href, elements, truncated: nodes.length > max };
    }, limit);
  }
  async close(): Promise<void> {
    const failures: unknown[] = [];
    if (!this.#closed) {
      this.#closed = true;
      try { await this.context.close(); } catch (error) { failures.push(error); }
      try { await this.browser.close(); } catch (error) { failures.push(error); }
    }
    try { await this.stop(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Browser cleanup needs verification; retry stop with the same browser ID.');
  }
  async [Symbol.asyncDispose](): Promise<void> { await this.close(); }
}
function point(x: number, y: number): void { if (![x, y].every(n => Number.isFinite(n) && n >= 0 && n <= 100000)) throw new Error('Invalid viewport coordinates.'); }
