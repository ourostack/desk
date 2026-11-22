import express from "express"
export function build(router) {
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => next())
  app.get("/healthz", (req, res) => res.send("ok"))
  app.all(["/a", "/b"], handler)
  app.use(authRouter({}))
  app.post(`/hooks/:id`, (req, res) => res.status(404).json({ error: "hook_not_found" }))
  app.get(router.path, handler)
  app.get("/healthz", handler)
  other.get("/not-this-app", handler)
  const errors = [{ code: "declared-only", means: "m", fix: "f" }]
  return app
}
