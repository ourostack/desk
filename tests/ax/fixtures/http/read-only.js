import express from "express"
export const OTHER = ["GET /post"]
export const READ_ONLY_ROUTES = ["GET /ping", "GET /gone", dynamic]
const app = express()
app.get("/ping", handler)
app.post("/post", handler)
