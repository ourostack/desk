// Verified GitHub linking (spec item 17): a signed-in account names a GitHub repository as its desk.
//
// The binding is recorded only when GitHub itself says the person may use that repository: the repository is in one
// of the "Ouro Desk" App's installations their user token can see (GET /user/installations and each one's
// repositories), they can push to it, and, read again with the App's installation token, the App's installation for
// it is the one listed and the collaborator permission is write, maintain or admin. One repository is one account's
// desk, claimed atomically in the store (claimRepo) before the binding is written. The binding keeps the GitHub user id
// and login, never the user token: that is used inside the callback and dropped. Each Desk session start rechecks the
// binding with the installation token (`sessionRefusal`): a binding whose access GitHub says is gone is suspended, and
// refused, until a later recheck passes or the person links again. A binding the operator seeded names no GitHub
// user, so its recheck asks only whether the App's installation still serves the repository.
//
// The pages, all behind the browser session (browser-session.js):
//   GET  /link/github                     what is linked, and a form to link (again)
//   POST /link/github action=start        to GitHub's authorization, with a sealed linking state
//   GET  /oauth/github/callback           GitHub's answer (the App's one callback URL; github.js hands linking states
//                                         here), which lists the repositories the person may link
//   POST /link/github action=choose       links the chosen repository, or offers `desk init` when it isn't a desk yet
//   POST /link/github action=init|decline makes it a desk and links it, or links nothing
import express from "express";
import { sealer } from "./seal.js";
import { authorizeUrlFor, exchangeCode, readUser } from "./github.js";
import { escapeHtml, htmlPage, page, pageRefusedPage, sendPage, signInUnavailablePage } from "./pages.js";
import { installationToken } from "../github-app.js";
import { PreconditionFailed, validRepo } from "../accounts/core.js";

const API = "https://api.github.com";
export const LINK_PATH = "/link/github";
const STATE_KIND = "github-link";
const CHOICE_KIND = "github-link-choice";
const PICK_KIND = "github-link-pick";
const STATE_TTL_SEC = 600;
const CHOICE_TTL_SEC = 900;
const CALL_TIMEOUT_MS = 10_000;
// Bounds on what one callback reads: a person in more installations or with more repositories than this sees the
// first ones only.
const MAX_INSTALLATIONS = 20;
const PER_PAGE = 100;
const WRITE_ROLES = new Set(["admin", "maintain", "write"]);
const WRITE_PERMISSIONS = new Set(["admin", "write"]);

const stderrLog = (message) => process.stderr.write(`desk-hosted link: ${message}\n`);

// What a Desk session start tells a person whose binding is suspended.
export const suspendedMessage = (issuer) =>
  `Your GitHub desk link is suspended: GitHub no longer gives you write access to the repository, or the Ouro Desk app was removed from it. Link it again at ${new URL(LINK_PATH, issuer).href}`;
// ...and one whose repository became another account's desk while it was suspended.
export const takenMessage = (issuer) =>
  `Your GitHub desk link is suspended: while it was, the repository became the desk of another Hosted Desk account. Link another repository at ${new URL(LINK_PATH, issuer).href}`;
// How many times a recheck reads the binding again after it changed mid-recheck (a relink, say).
const RECHECK_ATTEMPTS = 3;

const noreply = ({ githubUserId, login }) => `${githubUserId}+${login}@users.noreply.github.com`;

// GitHub saying the access is gone: the repository is now served by another installation than the binding's, or
// GitHub answers 404 (the App was uninstalled from it, the installation, repository or user no longer exists, or the
// installation can't see it). Every other failure is "try again", never a suspension: a 401 is our App's JWT or a
// stale token, a 403 or 429 a rate limit or our App's own fault, a 5xx or a timeout GitHub being down.
const accessGone = (error) => error?.code === "installation_mismatch" || error?.status === 404;

class GitHubError extends Error {
  constructor(status, path) {
    super(`GitHub answered ${status} to GET ${path}`);
    this.name = "GitHubError";
    this.status = status;
  }
}

// `store`: getAccount, getBinding, putBinding, removeBinding, repoBoundElsewhere. `sessions`: createBrowserSession's.
// `appId` and `privateKeyPem` are the App's; `clientId`, `clientSecret` and `callbackUrl` its user authorization.
// `initDesk({ accountId, binding })` makes the newly bound repository a desk (desk-init.js in the account's realm) and
// returns desk-init's result. `onLinked(accountId)` runs after a binding is recorded or changed, so the caller can drop
// what it cached for that account. `mint` stands in for github-app.js installationToken in tests.
export function createGitHubLink({
  key,
  keys,
  store,
  sessions,
  issuer,
  clientId,
  clientSecret,
  callbackUrl,
  appId,
  privateKeyPem,
  initDesk,
  onLinked = () => {},
  fetch = globalThis.fetch,
  mint = installationToken,
  timeoutMs = CALL_TIMEOUT_MS,
  now = Date.now,
  log = stderrLog,
}) {
  for (const [name, value] of Object.entries({ clientId, clientSecret, callbackUrl, issuer, privateKeyPem })) {
    if (typeof value !== "string" || value === "") throw new Error(`createGitHubLink needs ${name}`);
  }
  if (!store || !sessions) throw new Error("createGitHubLink needs the accounts store and the browser session");
  if (typeof initDesk !== "function") throw new Error("createGitHubLink needs initDesk");
  // DESK_APP_ID arrives as text; GitHub's `app_id` is a number.
  const appNumber = Number(appId);
  if (!Number.isSafeInteger(appNumber) || appNumber <= 0) throw new Error("createGitHubLink needs appId, the App's numeric id");
  const { sealed, unsealed } = sealer({ key, keys, now });

  async function get(path, token) {
    const response = await fetch(`${API}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "ouro-desk-hosted", "x-github-api-version": "2022-11-28" },
    });
    if (!response.ok) throw new GitHubError(response.status, path.split("?")[0]);
    return response.json();
  }

  // An installation token for `repo` from exactly `installationId`.
  const tokenFor = async (repo, installationId) => (await mint({ appId: appNumber, privateKeyPem, repo, installationId, fetch, now, timeoutMs })).token;

  // Whether `login` may push to `repo`, read with the installation token.
  async function canPush(repo, login, token) {
    const answer = await get(`/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`, token);
    return WRITE_ROLES.has(answer?.role_name) || WRITE_PERMISSIONS.has(answer?.permission);
  }

  // Rechecks a candidate with the App's own credentials. Returns `{ token }`, or `{ refused }` naming why. Throws when
  // GitHub can't answer.
  async function verify({ repo, installationId, login }) {
    let token;
    try {
      token = await tokenFor(repo, installationId);
    } catch (error) {
      if (accessGone(error)) return { refused: "not_installed" };
      throw error;
    }
    try {
      if (!(await canPush(repo, login, token))) return { refused: "no_write" };
    } catch (error) {
      if (accessGone(error)) return { refused: "no_write" };
      throw error;
    }
    return { token };
  }

  // Whether `repo` is a desk: `_meta` plus `_archive` (or a pre-V2 `desks`) at its root, as util/paths.js
  // isDeskWorkspace says for a clone.
  async function isDesk(repo, token) {
    const isDir = async (name) => {
      try {
        return Array.isArray(await get(`/repos/${repo}/contents/${name}`, token));
      } catch (error) {
        if (error?.status === 404) return false;
        throw error;
      }
    };
    return (await isDir("_meta")) && ((await isDir("_archive")) || (await isDir("desks")));
  }

  async function bindingFor(accountId, { repo, installationId, githubUserId, login }) {
    const account = await store.getAccount(accountId);
    return { kind: "github", repo, installationId, githubUserId, login, author: { name: account?.displayName || login, email: noreply({ githubUserId, login }) } };
  }

  // Records the binding after the final checks: the repository is claimed for the account first, so of two accounts
  // linking one repository only one can. `checked` is verify's answer when the caller already has it. Returns
  // `{ binding, token }` or `{ refused }`.
  async function link(accountId, pick, checked) {
    checked ??= await verify(pick);
    if (checked.refused) return { refused: checked.refused };
    if ((await store.claimRepo(pick.repo, accountId, { now: now() })).heldBy) return { refused: "bound_elsewhere", status: 409 };
    const binding = await bindingFor(accountId, pick);
    await store.putBinding(accountId, binding);
    return { binding, token: checked.token };
  }

  // The account's binding before a relink, or null for none or one this gateway can't read; throws the store's error.
  async function previousBinding(accountId) {
    try {
      return await store.getBinding(accountId);
    } catch (error) {
      if (error?.name === "StoreError") throw error;
      return null;
    }
  }

  // Frees `released` once the account's binding names `kept` instead, so another account can link it at once. A
  // failure only delays that: a claim stops holding once CLAIM_GRACE_MS has passed and the binding names another
  // repository.
  async function release(accountId, released, kept) {
    if (!released || released.toLowerCase() === kept?.toLowerCase()) return;
    try {
      await store.releaseRepo(released, accountId);
    } catch {
      log(`claim release failed: account ${accountId}`);
    }
  }

  // The plan's linkGitHub: links `repo` for `accountId` when `userToken`'s installations offer it with push access.
  // The token is read here and dropped.
  async function linkGitHub({ accountId, userToken, repo }) {
    const offered = await offeredTo(userToken);
    if (!offered) return { refused: "github_unconfirmed" };
    const candidate = offered.candidates.find((c) => c.repo === repo);
    if (!candidate) return { refused: "not_offered" };
    const previous = await previousBinding(accountId);
    const linked = await link(accountId, { ...candidate, githubUserId: offered.user.id, login: offered.user.login });
    if (linked.refused) return { refused: linked.refused };
    await release(accountId, previous?.repo, repo);
    onLinked(accountId);
    return { binding: linked.binding };
  }

  // What a user token offers: the user, and each repository in the App's installations they can see that they can
  // push to. Null when GitHub doesn't confirm the user.
  async function offeredTo(userToken) {
    const user = await readUser(userToken, fetch, timeoutMs);
    if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) return null;
    const { installations = [] } = await get(`/user/installations?per_page=${PER_PAGE}`, userToken);
    const candidates = [];
    for (const installation of installations.slice(0, MAX_INSTALLATIONS)) {
      if (!Number.isSafeInteger(installation?.id) || (installation.app_id !== undefined && installation.app_id !== appNumber)) continue;
      const { repositories = [] } = await get(`/user/installations/${installation.id}/repositories?per_page=${PER_PAGE}`, userToken);
      for (const repository of repositories) {
        const { push, maintain, admin } = repository?.permissions ?? {};
        if ((push || maintain || admin) && validRepo(repository.full_name)) candidates.push({ repo: repository.full_name, installationId: installation.id });
      }
    }
    return { user: { id: user.id, login: user.login }, candidates };
  }

  // Desk session start: "ok" (linked and still allowed), "suspended" (GitHub says the App or the person lost access;
  // recorded on the binding), "taken" (access is back, but while the binding was suspended its repository became
  // another account's desk; it stays suspended), "unavailable" (GitHub didn't answer; nothing recorded, try again) or
  // "none" (no binding). A binding the operator seeded names no GitHub user, so only the App's installation is
  // checked for it. Every write is conditional on the binding read: one that changed meanwhile (a relink in the
  // browser) is never overwritten, and the new one is rechecked instead. Throws when the store can't answer.
  async function recheckBinding({ accountId }) {
    for (let attempt = 0; attempt < RECHECK_ATTEMPTS; attempt++) {
      const entry = await store.getBindingEntry(accountId);
      if (!entry) return "none";
      const { binding, etag } = entry;
      let allowed;
      let login = binding.login;
      try {
        const token = await tokenFor(binding.repo, binding.installationId);
        if (binding.githubUserId === undefined) {
          allowed = true;
        } else {
          // A login can be renamed; the id can't.
          login = (await get(`/user/${binding.githubUserId}`, token))?.login ?? login;
          allowed = await canPush(binding.repo, login, token);
        }
      } catch (error) {
        if (!accessGone(error)) {
          log(`recheck unavailable: account ${accountId}`);
          return "unavailable";
        }
        allowed = false;
      }
      try {
        if (!allowed) {
          if (!binding.suspended) await store.replaceBinding(accountId, { ...binding, suspended: true }, etag);
          log(`binding suspended: account ${accountId}`);
          return "suspended";
        }
        if (binding.suspended && (await store.claimRepo(binding.repo, accountId, { now: now() })).heldBy) {
          log(`binding taken: account ${accountId}`);
          return "taken";
        }
        if (binding.suspended || login !== binding.login) {
          const { suspended: _suspended, ...rest } = binding;
          await store.replaceBinding(accountId, { ...rest, login }, etag);
          onLinked(accountId);
        }
        return "ok";
      } catch (error) {
        if (!(error instanceof PreconditionFailed)) throw error;
      }
    }
    log(`recheck unavailable: account ${accountId} (the binding kept changing)`);
    return "unavailable";
  }

  // Session start's one call: null when the account's desk may start, else the message to refuse the session with.
  // An account with no binding gets null here; the runtime refuses it itself, as it always has.
  async function sessionRefusal(accountId) {
    const state = await recheckBinding({ accountId });
    if (state === "suspended") return suspendedMessage(issuer);
    if (state === "taken") return takenMessage(issuer);
    if (state === "unavailable") return "GitHub didn't answer while Hosted Desk checked your desk link. Try again in a minute.";
    return null;
  }

  // ---- pages

  const form = (csrf, fields, buttons) =>
    `<form method="post" action="${LINK_PATH}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">` +
    Object.entries(fields)
      .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`)
      .join("") +
    buttons +
    "</form>";
  const button = (action, label) => `<button type="submit" name="action" value="${action}">${escapeHtml(label)}</button>`;
  const startForm = (csrf, label) => form(csrf, {}, button("start", label));

  function statusPage(binding, csrf) {
    if (!binding) return htmlPage(200, `<p>No GitHub desk is linked to this account yet.</p>${startForm(csrf, "Link a GitHub desk")}`);
    const repo = `<strong>${escapeHtml(binding.repo)}</strong>`;
    if (binding.suspended) {
      return htmlPage(200, `<p>Your link to ${repo} is suspended: GitHub no longer gives you write access to it, or the Ouro Desk app was removed from it. Fix that on GitHub, then link it again.</p>${startForm(csrf, "Link again")}`);
    }
    return htmlPage(200, `<p>Your desk is ${repo}.</p>${startForm(csrf, "Link another repository")}`);
  }

  function choicePage(offered, accountId, csrf) {
    if (offered.candidates.length === 0) {
      return htmlPage(200, "<p>None of the repositories the Ouro Desk GitHub App can reach gives you write access. Install the Ouro Desk GitHub App on your desk repository, then link again.</p>" + startForm(csrf, "Link again"));
    }
    const choice = sealed(CHOICE_KIND, { accountId, githubUserId: offered.user.id, login: offered.user.login, candidates: offered.candidates }, CHOICE_TTL_SEC);
    const options = offered.candidates
      .map(({ repo }, i) => `<p><label><input type="radio" name="repo" value="${escapeHtml(repo)}"${i === 0 ? " checked" : ""}> ${escapeHtml(repo)}</label></p>`)
      .join("");
    return htmlPage(200, `<p>Which repository is your desk?</p>${form(csrf, { choice }, options + button("choose", "Link this repository"))}`);
  }

  const offerPage = (pick, csrf) =>
    htmlPage(
      200,
      `<p><strong>${escapeHtml(pick.repo)}</strong> isn't a desk yet. Desk can add its folders and a first commit to it, or you can choose another repository.</p>` +
        form(csrf, { pick: sealed(PICK_KIND, pick, CHOICE_TTL_SEC) }, button("init", "Make it a desk") + button("decline", "Cancel")),
    );

  const linkedPage = (repo, made) => htmlPage(200, `<p>Linked <strong>${escapeHtml(repo)}</strong> as your desk${made ? " and made it a desk" : ""}. Connect Hosted Desk in Claude to start working in it.</p>`);
  const startLinkingAgain = (message) => page(400, `${message} Start linking again from ${LINK_PATH}.`);
  const REFUSALS = {
    not_offered: () => page(403, "That repository isn't one you can link: the Ouro Desk app must be installed on it and you must be able to push to it."),
    not_installed: () => page(403, "The Ouro Desk app's installation for that repository has changed. Link again."),
    no_write: () => page(403, "GitHub says you don't have write access to that repository, so it can't be your desk."),
    bound_elsewhere: () => page(409, "That repository is already the desk of another account."),
  };
  const unavailable = () => signInUnavailablePage({ page: true });
  const toSignIn = (res) => res.redirect(303, `/signin?next=${encodeURIComponent(LINK_PATH)}`);

  // The session's account, or null after sending the browser to sign in; throws the store's error.
  async function sessionAccount(req, res) {
    const accountId = await sessions.require(req);
    if (!accountId) toSignIn(res);
    return accountId;
  }

  const guarded = (handler) => async (req, res) => {
    res.setHeader("cache-control", "no-store");
    try {
      await handler(req, res);
    } catch (error) {
      log(`page failed: ${error?.name === "StoreError" ? "store_unavailable" : "github_unavailable"}`);
      if (!res.headersSent) sendPage(res, unavailable());
    }
  };

  async function callback(req, res) {
    const text = (value) => (typeof value === "string" ? value : undefined);
    const state = unsealed(STATE_KIND, text(req.query.state));
    const accountId = await sessionAccount(req, res);
    if (!accountId) return;
    if (!state || state.accountId !== accountId) {
      log(`link refused: other_session account ${accountId}`);
      return sendPage(res, startLinkingAgain("This GitHub answer belongs to linking started in another browser or by another account."));
    }
    const code = text(req.query.code);
    if (text(req.query.error) || !code) return sendPage(res, htmlPage(200, `<p>Linking was cancelled on GitHub. Nothing was linked.</p>${startForm(sessions.csrfToken(req), "Link again")}`));
    const userToken = await exchangeCode({ clientId, clientSecret, callbackUrl, code, fetch, timeoutMs });
    const offered = userToken ? await offeredTo(userToken) : null;
    if (!offered) {
      log(`link refused: github_unconfirmed account ${accountId}`);
      return sendPage(res, page(502, `GitHub did not confirm who you are. Start linking again from ${LINK_PATH}.`));
    }
    sendPage(res, choicePage(offered, accountId, sessions.csrfToken(req)));
  }

  async function finish(res, accountId, pick, outcome) {
    if (outcome.refused) {
      log(`link refused: ${outcome.refused} account ${accountId}`);
      return sendPage(res, REFUSALS[outcome.refused]());
    }
    log(`linked: account ${accountId}`);
    onLinked(accountId);
    sendPage(res, linkedPage(pick.repo, false));
  }

  async function post(req, res) {
    const accountId = await sessionAccount(req, res);
    if (!accountId) return;
    if (!sessions.checkCsrf(req, accountId)) {
      log(`link refused: csrf account ${accountId}`);
      return sendPage(res, pageRefusedPage());
    }
    const csrf = sessions.csrfToken(req);
    const action = req.body?.action;
    if (action === "start") {
      return res.redirect(303, authorizeUrlFor({ clientId, callbackUrl, state: sealed(STATE_KIND, { accountId }, STATE_TTL_SEC) }));
    }
    if (action === "choose") {
      const choice = unsealed(CHOICE_KIND, req.body?.choice);
      if (!choice || choice.accountId !== accountId || !Array.isArray(choice.candidates)) return sendPage(res, startLinkingAgain("This choice has expired or isn't valid."));
      const candidate = choice.candidates.find((c) => c.repo === req.body?.repo);
      if (!candidate) return finish(res, accountId, null, { refused: "not_offered" });
      const pick = { repo: candidate.repo, installationId: candidate.installationId, githubUserId: choice.githubUserId, login: choice.login, accountId };
      const checked = await verify(pick);
      if (checked.refused) return finish(res, accountId, pick, checked);
      if (await store.repoBoundElsewhere(pick.repo, accountId)) return finish(res, accountId, pick, { refused: "bound_elsewhere" });
      if (!(await isDesk(pick.repo, checked.token))) return sendPage(res, offerPage(pick, csrf));
      const previous = await previousBinding(accountId);
      const linked = await link(accountId, pick, checked);
      if (!linked.refused) await release(accountId, previous?.repo, pick.repo);
      return finish(res, accountId, pick, linked);
    }
    if (action === "init" || action === "decline") {
      const pick = unsealed(PICK_KIND, req.body?.pick);
      if (!pick || pick.accountId !== accountId) return sendPage(res, startLinkingAgain("This offer has expired or isn't valid."));
      if (action === "decline") return sendPage(res, htmlPage(200, `<p>Nothing was linked.</p>${startForm(csrf, "Link a GitHub desk")}`));
      return makeDesk(res, accountId, pick);
    }
    sendPage(res, startLinkingAgain("That isn't something this page does."));
  }

  // Links the picked repository and runs desk init in it. A failed init puts back whatever binding the account had,
  // so the person is never left bound to a repository that isn't a desk.
  // The binding is recorded before init because the realm clones the repository its stored binding names; a
  // session that starts during init sees a repository that isn't a desk yet, as it would without Hosted Desk.
  async function makeDesk(res, accountId, pick) {
    // Any read failure, an unreadable row included, stops here: the rollback must never erase a row it couldn't read.
    const previous = await store.getBinding(accountId);
    const linked = await link(accountId, pick);
    if (linked.refused) return finish(res, accountId, pick, linked);
    let result;
    try {
      result = await initDesk({ accountId, binding: linked.binding });
    } catch {
      result = { status: "error" };
    }
    if (result?.status === "created" || result?.reason === "already_a_desk") {
      log(`linked: account ${accountId} (desk init ${result.status})`);
      await release(accountId, previous?.repo, pick.repo);
      onLinked(accountId);
      return sendPage(res, linkedPage(pick.repo, result.status === "created"));
    }
    try {
      if (previous) await store.putBinding(accountId, previous);
      else await store.removeBinding(accountId);
      await release(accountId, pick.repo, previous?.repo);
    } catch (error) {
      log(`link failed: desk_init rollback_failed account ${accountId}`);
      throw error;
    } finally {
      onLinked(accountId);
    }
    log(`link failed: desk_init ${typeof result?.step === "string" && /^\w{1,32}$/.test(result.step) ? result.step : "error"} account ${accountId}`);
    sendPage(res, page(502, `Desk couldn't make ${pick.repo} a desk, so nothing was linked. Try again, or choose another repository.`));
  }

  function router() {
    const routes = express.Router();
    routes.get(
      LINK_PATH,
      guarded(async (req, res) => {
        const accountId = await sessionAccount(req, res);
        if (!accountId) return;
        let binding;
        try {
          binding = await store.getBinding(accountId);
        } catch (error) {
          if (error?.name === "StoreError") throw error;
          binding = null;
        }
        sendPage(res, statusPage(binding, sessions.csrfToken(req)));
      }),
    );
    routes.post(LINK_PATH, express.urlencoded({ extended: false, limit: "16kb" }), guarded(post));
    return routes;
  }

  return {
    router,
    // Whether GitHub's answer `state` is a linking state (github.js githubCallbackHandler routes it here).
    ownsState: (state) => unsealed(STATE_KIND, typeof state === "string" ? state : undefined) !== null,
    callbackHandler: guarded(callback),
    linkGitHub,
    recheckBinding,
    sessionRefusal,
  };
}
