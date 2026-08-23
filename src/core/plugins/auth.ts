import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { fromNodeHeaders } from "better-auth/node";
import { auth, type Session } from "../auth.js";

declare module "fastify" {
  interface FastifyRequest {
    getSession(): Promise<Session | null>;
  }
}

const authPlugin = async (app: FastifyInstance) => {
  app.decorateRequest("getSession", async function (this: FastifyRequest) {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(this.headers) });
    return session as Session | null;
  });

  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const headers = fromNodeHeaders(request.headers);

      const webRequest = new Request(url.toString(), {
        method: request.method,
        headers,
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      });

      const response = await auth.handler(webRequest);

      reply.status(response.status);
      response.headers.forEach((value, key) => reply.header(key, value));
      reply.send(response.body ? await response.text() : null);
    },
  });
};

export default fp(authPlugin, { name: "auth-plugin" });
