#!/usr/bin/env node
import { Writable, Readable } from "node:stream";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { GenericAcpAgent } from "./acp/agent.js";
import { loadConfig } from "./config/config.js";

const config = loadConfig();

const stream = ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);

new AgentSideConnection((conn) => new GenericAcpAgent(conn, config), stream);
