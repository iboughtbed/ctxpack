import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import { auth } from "@repo/auth";
import { isRemoteExecutionMode } from "@repo/sandbox";

import type { Context } from "./context";
import { withAuth } from "./middleware";
import { routers } from "./routes";

const app = new OpenAPIHono<Context>();
const isRemoteMode = isRemoteExecutionMode();

// logger
app.use(logger());

if (isRemoteMode) {
  // cors
  app.use(
    "*",
    cors({
      origin: process.env.NEXT_PUBLIC_APP_URL as string,
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: [
        "Content-Type",
        "Authorization",
        "x-api-key",
        "x-ctxpack-provider-keys",
        "x-ctxpack-model-config",
      ],
      exposeHeaders: ["Content-Length", "Content-Type", "Cache-Control"],
      maxAge: 86400,
      credentials: true,
    }),
  );
}

// health endpoint
app.get("/health", (c) => {
  return c.json({ status: "ok" }, 200);
});

// better-auth
app.on(["GET", "POST"], "/api/auth/*", (c) => {
  return auth.handler(c.req.raw);
});

// routes
app.use("*", withAuth);
app.route("/", routers);

// openapi docs
app.doc("/doc", {
  openapi: "3.0.0",
  info: {
    version: "0.1.0",
    title: "ctxpack API",
  },
});

export default {
  fetch: app.fetch,
  port: Number(process.env.PORT ?? 3000),
  idleTimeout: 255, // 255 seconds limit on Bun.serve
};
