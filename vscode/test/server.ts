import { createServer, type Server, type Socket } from "node:net";
import { afterEach } from "vitest";

const servers: Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

// Starts a local server that hands each connection to `handle`, resolving to its port.
export async function serve(handle: (socket: Socket) => void): Promise<number> {
  const server = createServer((socket) => {
    // The client hangs up mid-write in some tests; that is expected.
    socket.on("error", () => {});
    handle(socket);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected a TCP address");
  return address.port;
}

// Encodes a successful Scry response frame for `requestId`.
export function reply(requestId: string): Buffer {
  const payload = Buffer.from(
    JSON.stringify({ version: 1, requestId, status: "ok", kind: "expression", result: "3", output: "", diagnostics: [] }),
  );
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  return Buffer.concat([length, payload]);
}
