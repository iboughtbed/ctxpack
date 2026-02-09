import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import { auth } from "@repo/auth";
import { closeDbConnection } from "@repo/db";
import { isRemoteExecutionMode } from "@repo/sandbox";

import type { Context } from "./context";
import { withAuth } from "./middleware";
import { routers } from "./routes";

const DEFAULT_PORT = 8787;
const DEFAULT_IDLE_TIMEOUT = 255;

export type CreateAppOptions = {
  remoteMode?: boolean;
};

export type CreateServerOptions = {
  port?: number;
  hostname?: string;
  idleTimeout?: number;
  remoteMode?: boolean;
};

export type ServerInstance = {
  port: number;
  url: string;
  server: ReturnType<typeof Bun.serve>;
  stop: () => Promise<void>;
};

function resolveRemoteMode(value?: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  return isRemoteExecutionMode();
}

export function createApp(options: CreateAppOptions = {}): OpenAPIHono<Context> {
  const app = new OpenAPIHono<Context>();
  const isRemoteMode = resolveRemoteMode(options.remoteMode);

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

  return app;
}

export function createServer(options: CreateServerOptions = {}): ServerInstance {
  const app = createApp(options);
  const server = Bun.serve({
    fetch: app.fetch,
    port: options.port ?? Number(process.env.PORT ?? DEFAULT_PORT),
    hostname: options.hostname,
    idleTimeout: options.idleTimeout ?? DEFAULT_IDLE_TIMEOUT,
  });
  const port = server.port ?? options.port ?? Number(process.env.PORT ?? DEFAULT_PORT);
  let stopped = false;

  return {
    port,
    url: `http://localhost:${String(port)}`,
    server,
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      try {
        server.stop(true);
      } catch {
        // ignore stop races
      }
      try {
        await closeDbConnection();
      } catch {
        // ignore DB close failures during shutdown
      }
    },
  };
}

export const startServer = createServer;

export default {
  fetch: createApp().fetch,
  port: Number(process.env.PORT ?? DEFAULT_PORT),
  idleTimeout: DEFAULT_IDLE_TIMEOUT,
};
