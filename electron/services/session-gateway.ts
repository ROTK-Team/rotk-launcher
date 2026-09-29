import { createHash } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { isValidLaunchTicket } from "../../shared/launch-ticket.js";

const CREATE_SESSION_PATH = "/rest/auth/session/create";
const LOOPBACK_HOST = "127.0.0.1";

export interface LocalSessionGateway {
  createSessionUrl: string;
  close(): Promise<void>;
}

export function buildCreateSessionXml(launchTicket: string, country = "FR"): string {
  if (!isValidLaunchTicket(launchTicket)) throw new Error("Invalid ROTK launch ticket");
  const securityKey = createHash("sha512")
    .update("h1z1-kotk-local-gateway")
    .digest("base64");
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    "<createsessionresponse>" +
    `<country>${country}</country>` +
    `<securityKey>${securityKey}</securityKey>` +
    `<sessionid>${launchTicket}</sessionid>` +
    "<status>SUCCESS</status>" +
    "</createsessionresponse>"
  );
}

function sendText(
  response: ServerResponse,
  statusCode: number,
  body: string,
  contentType: string,
): void {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "X-Content-Type-Options": "nosniff",
    Connection: "close",
  });
  response.end(body);
}

function isAllowedRequest(request: IncomingMessage, expectedHost: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(request.url ?? "", `http://${expectedHost}`).pathname;
  } catch {
    return false;
  }
  return (
    request.method === "POST" &&
    pathname === CREATE_SESSION_PATH &&
    request.url === CREATE_SESSION_PATH &&
    request.socket.remoteAddress === LOOPBACK_HOST &&
    request.headers.host === expectedHost &&
    request.headers.origin === undefined
  );
}

export async function startLocalSessionGateway(launchTicket: string): Promise<LocalSessionGateway> {
  const xml = buildCreateSessionXml(launchTicket);
  let expectedHost = "";
  const server = http.createServer((request, response) => {
    request.resume();
    if (!isAllowedRequest(request, expectedHost)) {
      sendText(response, 403, "Forbidden\n", "text/plain; charset=utf-8");
      return;
    }
    sendText(response, 200, xml, "application/xml;charset=UTF-8");
  });
  server.maxConnections = 4;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, LOOPBACK_HOST, () => {
      server.off("error", onError);
      // A later socket error must not become an uncaught exception.
      server.on("error", () => undefined);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Unable to bind the local ROTK session gateway");
  }
  expectedHost = `${LOOPBACK_HOST}:${address.port}`;
  const createSessionUrl = `http://${expectedHost}${CREATE_SESSION_PATH}`;

  let closed = false;
  return {
    createSessionUrl,
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}
