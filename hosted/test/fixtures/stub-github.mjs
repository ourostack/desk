// Preloaded into the gateway by the end-to-end test (`node --import`): a stub
// GitHub API, so minting an installation token never reaches the network.
// It answers the two calls the gateway's App credentials make and refuses
// every other fetch.
const API = "https://api.github.com";

globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  const method = (init.method ?? "GET").toUpperCase();
  if (method === "GET" && /^\/repos\/[^/]+\/[^/]+\/installation$/.test(url.slice(API.length)) && url.startsWith(API)) {
    return Response.json({ id: 1 });
  }
  if (method === "POST" && url === `${API}/app/installations/1/access_tokens`) {
    return Response.json({ token: "ghs_e2e_stub_token", expires_at: new Date(Date.now() + 3600_000).toISOString() }, { status: 201 });
  }
  throw new Error(`stub GitHub: no network in the end-to-end test (${method} ${url})`);
};
