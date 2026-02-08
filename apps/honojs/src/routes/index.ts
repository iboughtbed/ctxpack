import { OpenAPIHono } from "@hono/zod-openapi";

import { jobsRouter } from "./jobs";
import { resourcesRouter } from "./resources";
import { searchRouter } from "./search";
import { toolsRouter } from "./tools";

const routers = new OpenAPIHono();

routers.route("/", resourcesRouter);
routers.route("/", jobsRouter);
routers.route("/", searchRouter);
routers.route("/", toolsRouter);

export { routers };
