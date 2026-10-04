import path from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { config, FIXTURES } from "./config.js";
import { registerMockApi } from "./mock-api.js";

/** Pathik Rail (and its documents) on its own origin, for scripts and the eval. */
export async function startMockSite(port = config.mockPort) {
  const mock = Fastify();
  await mock.register(fastifyStatic, { root: path.join(FIXTURES, "pathik-rail") });
  await mock.register(fastifyStatic, { root: path.join(FIXTURES, "bills/out"), prefix: "/docs/", decorateReply: false });
  // Saved copies of real sites, for reading tasks that must run offline in CI.
  await mock.register(fastifyStatic, { root: path.join(FIXTURES, "sites"), prefix: "/sites/", decorateReply: false });
  registerMockApi(mock);
  await mock.listen({ port, host: "127.0.0.1" });
  return mock;
}
