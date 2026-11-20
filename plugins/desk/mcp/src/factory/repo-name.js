// The one definition of a GitHub `<owner>/<repo>` shape that every Factory, store and card check shares. An owner is at most 39
// characters of letters, digits and hyphens; a single `_` is allowed between them because every Enterprise Managed Users login has
// one (`name_company`). An owner never starts or ends with `_` and never holds `__`, so the store folder name `owner__repo`
// (`outbox.js`) still splits into exactly one owner and one repository.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/` files.

export const OWNER_SOURCE = "(?!_)(?:[A-Za-z0-9-]|_(?=[A-Za-z0-9-])){1,39}"
export const REPO_SOURCE = "[A-Za-z0-9._-]{1,100}"
export const SLUG_SOURCE = `${OWNER_SOURCE}/${REPO_SOURCE}`

/** `<owner>/<repo>` as a whole string. */
export const SLUG = new RegExp(`^${SLUG_SOURCE}$`, "u")
