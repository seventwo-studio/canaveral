import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { BrowserRuntimeOptions } from './browser-runtime.ts';

interface LaunchProgress {
  readonly signal: AbortSignal;
  race<T>(work: Promise<T> | Promise<T>[]): Promise<T>;
}

interface NativeBrowser {
  close(progress: LaunchProgress, options: { reason: string }): Promise<void>;
}

interface NativeProxy {
  setPattern(pattern: string): void;
  listen(port: number, host: string): Promise<number>;
  close(): Promise<void>;
}

interface NativeServer {
  listen(port: number, host: string): Promise<string>;
  close(): Promise<void>;
}

// Playwright's public launchServer() never wires a SOCKS dispatcher into a
// pre-launched browser. Use the corresponding pieces of our pinned release.
const core = createRequire(import.meta.url)('playwright-core/lib/coreBundle') as {
  server: {
    nullProgress: LaunchProgress;
    createPlaywright(options: { sdkLanguage: string; isServer: boolean }): Record<
      'chromium' | 'firefox' | 'webkit',
      { launch(progress: LaunchProgress, options: { headless: boolean; chromiumSandbox: boolean; socksProxyPort?: number }): Promise<NativeBrowser> }
    >;
  };
  utils: { SocksProxy: new () => NativeProxy };
  remote: {
    PlaywrightServer: new (options: {
      mode: 'launchServer';
      path: string;
      maxConnections: number;
      preLaunchedBrowser: NativeBrowser;
      preLaunchedSocksProxy?: NativeProxy;
    }) => NativeServer;
  };
};

/** Operator adapter for one loopback browser server and its forwarding proxy. */
export const launchPlaywrightBrowser: BrowserRuntimeOptions['launch'] = async (engine, localPorts) => {
  const proxy = localPorts.length ? new core.utils.SocksProxy() : undefined;
  const playwright = core.server.createPlaywright({ sdkLanguage: 'javascript', isServer: true });
  const signal = AbortSignal.timeout(25_000);
  const progress: LaunchProgress = {
    ...core.server.nullProgress,
    signal,
    async race<T>(work: Promise<T> | Promise<T>[]) {
      const tasks = Array.isArray(work) ? work : [work];
      let abort: () => void = () => {};
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
      try { return await Promise.race([...tasks, cancelled]); }
      finally { signal.removeEventListener('abort', abort); }
    },
  };
  let browser: NativeBrowser | undefined;
  let server: NativeServer | undefined;
  try {
    proxy?.setPattern(localPorts.map(port => `127.0.0.1:${port}`).join(','));
    const socksProxyPort = await proxy?.listen(0, '127.0.0.1');
    browser = await playwright[engine].launch(progress, {
      headless: true,
      chromiumSandbox: true,
      ...(socksProxyPort === undefined ? {} : { socksProxyPort }),
    });
    server = new core.remote.PlaywrightServer({
      mode: 'launchServer',
      path: '/' + randomUUID(),
      maxConnections: localPorts.length ? 1 : Infinity,
      preLaunchedBrowser: browser,
      ...(proxy ? { preLaunchedSocksProxy: proxy } : {}),
    });
    const endpoint = await server.listen(0, '127.0.0.1');
    const ownedServer = server;
    return {
      wsEndpoint: () => endpoint,
      async close() {
        await Promise.all([ownedServer.close(), proxy?.close()]);
      },
    };
  } catch (error) {
    await Promise.allSettled([
      server ? server.close() : browser?.close(core.server.nullProgress, { reason: 'Browser startup failed' }),
      proxy?.close(),
    ]);
    throw error;
  }
};
