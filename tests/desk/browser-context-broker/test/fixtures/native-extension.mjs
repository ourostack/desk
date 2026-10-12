// The native provider wired to the real extension code, with just enough of chrome.* for lease binding and owner windows.
const root = new URL('../../../../../plugins/desk/', import.meta.url);
const { NativeCommandTransport } = await import(new URL('browser-context-broker/src/native-cdp.mjs', root));

export const browser = { pid: 700, startIdentity: 'browser-1', owner: 'operator', executable: '/opt/browser', profileRoot: '/profiles/Default' };
const entry = { pid: 701, parentPid: 700, startIdentity: 'entry-1', owner: 'operator', executable: '/opt/entry', profileRoot: '/runtime' };
const runtime = { pid: 702, parentPid: 701, startIdentity: 'runtime-1', owner: 'operator', executable: '/opt/node', profileRoot: '/runtime' };
export const token = 'a'.repeat(64);
const extensionId = 'bcejpajaingepdloiolbmbaflecgifbe';

function event() {
  const listeners = new Set();
  return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit: (...args) => listeners.forEach(fn => fn(...args)) };
}

// Just enough of chrome.* for lease binding and owner windows.
export function fakeChrome(options = {}) {
  let next = 1;
  let contexts = [];
  const tabs = new Map();
  const windows = new Map();
  const chrome = {
    runtime: { id: extensionId, onStartup: event(), onInstalled: event(), onMessage: event(),
      getURL: file => `chrome-extension://${extensionId}/${file}`, getContexts: async () => contexts, sendMessage: async () => ({ token }) },
    offscreen: { createDocument: async () => { contexts = [{ documentUrl: chrome.runtime.getURL('token.html') }]; } },
    windows: {
      get: async id => {
        if (!windows.has(id)) throw new Error('No window with id');
        return { id, left: 0, top: 0, width: 800, height: 600, state: 'normal' };
      },
      create: async params => {
        if (options.createDelayMs) await new Promise(resolve => setTimeout(resolve, options.createDelayMs));
        const id = next++;
        const tab = { id: next++, windowId: id, url: params.url, status: 'complete',
          title: params.url.startsWith('data:') ? 'Desk target marker' : '' };
        tabs.set(tab.id, tab);
        windows.set(id, { id });
        return { id, tabs: [tab] };
      },
    },
    tabs: {
      onCreated: event(), onRemoved: event(),
      get: async id => { const tab = tabs.get(id); if (!tab) throw new Error('No tab with id'); return { ...tab }; },
      update: async (id, params) => {
        const tab = tabs.get(id);
        Object.assign(tab, params);
        if (params.url?.includes('/control.html#')) {
          const { owner, work } = JSON.parse(decodeURIComponent(params.url.split('#')[1]));
          tab.title = `Desk | ${owner}${work === null || work === undefined ? '' : ` | ${work}`}`;
        }
        return { ...tab };
      },
      remove: async id => { if (!tabs.delete(id)) throw new Error('No tab with id'); chrome.tabs.onRemoved.emit(id, {}); },
    },
    debugger: { onEvent: event(), onDetach: event(),
      getTargets: async () => [...tabs.values()].map(tab => ({ id: `target-${tab.id}`, tabId: tab.id, type: 'page' })),
      attach: async () => {}, detach: async () => {},
      sendCommand: async ({ tabId }, method, params) => {
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: `frame-${tabId}` } } };
        if (method === 'Runtime.evaluate') return { result: { value: true } };
        if (method === 'Page.navigate') tabs.get(tabId).url = params.url;
        return {};
      } },
  };
  return { chrome, tabs };
}

// One native host process: a transport to the extension and the provider it starts. The extension object outlives it.
export function host(extension, generation) {
  const transport = new NativeCommandTransport({ send: async message => { transport.receive(await extension.dispatch(message)); } });
  return { transport, contextIdentity: { processIdentity: browser, mediationChain: [entry, runtime], endpointProcessIdentity: runtime,
    profileToken: token, transportGeneration: generation, browserVersion: 'Edg/155.0.0.0', userAgent: 'fixture',
    extensionSourceDigest: 'c'.repeat(64) } };
}

export const processReader = async pid => [browser, entry, runtime].find(identity => identity.pid === pid);

