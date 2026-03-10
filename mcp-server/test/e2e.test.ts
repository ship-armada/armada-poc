// ABOUTME: End-to-end test for the MCP server protocol over stdio.
// ABOUTME: Spawns the server process and validates MCP handshake and tool listing.

import { expect } from "chai";
import { spawn, ChildProcess } from "child_process";
import * as path from "path";

const SERVER_PATH = path.resolve(__dirname, "../src/server.ts");
const PROJECT_ROOT = path.resolve(__dirname, "../..");

describe("MCP Server — E2E Tests", function () {
  this.timeout(30_000);

  let serverProcess: ChildProcess;

  afterEach(function () {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill();
    }
  });

  /**
   * Send a JSON-RPC message to the server and collect the response.
   */
  function sendAndReceive(
    proc: ChildProcess,
    message: object
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for server response"));
      }, 10_000);

      let buffer = "";
      const onData = (data: Buffer) => {
        buffer += data.toString();
        // MCP uses newline-delimited JSON
        const lines = buffer.split("\n").filter((l) => l.trim());
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            clearTimeout(timeout);
            proc.stdout!.removeListener("data", onData);
            resolve(parsed);
            return;
          } catch {
            // Not complete JSON yet, keep buffering
          }
        }
      };

      proc.stdout!.on("data", onData);
      proc.stdin!.write(JSON.stringify(message) + "\n");
    });
  }

  function startServer(): ChildProcess {
    return spawn("npx", ["ts-node", "--project", "tsconfig.json", SERVER_PATH], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, DEPLOY_ENV: "local" },
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  it("completes MCP protocol handshake (initialize)", async function () {
    serverProcess = startServer();

    const initMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "0.1.0" },
      },
    };

    const response = await sendAndReceive(serverProcess, initMessage);

    expect(response.jsonrpc).to.equal("2.0");
    expect(response.id).to.equal(1);
    expect(response.result).to.be.an("object");
    expect(response.result.protocolVersion).to.be.a("string");
    expect(response.result.serverInfo).to.be.an("object");
    expect(response.result.serverInfo.name).to.equal("armada");
  });

  it("lists available tools", async function () {
    serverProcess = startServer();

    // Must initialize first
    const initMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "0.1.0" },
      },
    };

    await sendAndReceive(serverProcess, initMessage);

    // Send initialized notification (required by MCP protocol)
    serverProcess.stdin!.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"
    );

    // List tools
    const listMessage = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    };

    const response = await sendAndReceive(serverProcess, listMessage);

    expect(response.result).to.be.an("object");
    expect(response.result.tools).to.be.an("array");

    const toolNames = response.result.tools.map((t: any) => t.name);
    expect(toolNames).to.include("get_deployment_state");
    expect(toolNames).to.include("get_chain_health");
    expect(toolNames).to.include("get_contract_state");
    expect(toolNames).to.have.length(3);
  });

  it("get_deployment_state tool returns valid report", async function () {
    serverProcess = startServer();

    // Initialize
    await sendAndReceive(serverProcess, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "0.1.0" },
      },
    });

    serverProcess.stdin!.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"
    );

    // Call tool
    const callMessage = {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "get_deployment_state",
        arguments: {},
      },
    };

    const response = await sendAndReceive(serverProcess, callMessage);

    expect(response.result).to.be.an("object");
    expect(response.result.content).to.be.an("array");
    expect(response.result.content[0].type).to.equal("text");

    const report = JSON.parse(response.result.content[0].text);
    expect(report.env).to.equal("local");
    expect(report.files).to.be.an("array");
    expect(report.hub).to.be.an("object");
    expect(report.issues).to.be.an("array");
  });
});
