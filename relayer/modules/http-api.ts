/**
 * HTTP API Module
 *
 * Express server providing the relayer's public API:
 *   GET  /fees         — Current fee schedule
 *   POST /relay        — Submit a shielded transaction
 *   GET  /status/:hash — Check transaction status
 */

import express from "express";
import cors from "cors";
import { RelayError } from "../types";
import type { RelayRequest, RelayerHealth } from "../types";
import type { PrivacyRelay } from "./privacy-relay";
import type { FeeCalculator } from "./fee-calculator";
import type { Counters } from "./counters";

// ============ HTTP API ============

export class HttpApi {
  private app: express.Application;
  private port: number;
  private privacyRelay: PrivacyRelay;
  private feeCalculator: FeeCalculator;
  private getHealth: () => RelayerHealth;
  private counters: Counters;
  private server: ReturnType<express.Application["listen"]> | null = null;

  constructor(
    port: number,
    privacyRelay: PrivacyRelay,
    feeCalculator: FeeCalculator,
    getHealth: () => RelayerHealth,
    counters: Counters,
  ) {
    this.port = port;
    this.privacyRelay = privacyRelay;
    this.feeCalculator = feeCalculator;
    this.getHealth = getHealth;
    this.counters = counters;

    this.app = express();
    this.app.use(cors());
    this.app.use(express.json());

    this.setupRoutes();
  }

  private setupRoutes(): void {
    // GET /fees — Current fee schedule
    this.app.get("/fees", async (_req, res) => {
      try {
        const fees = await this.feeCalculator.getCurrentFees();
        res.json(fees);
      } catch (e: any) {
        console.error("[http-api] Error fetching fees:", e);
        res.status(500).json({ error: "Failed to calculate fees" });
      }
    });

    // POST /relay — Submit a shielded transaction
    this.app.post("/relay", async (req, res) => {
      try {
        const { chainId, to, data, feesCacheId } = req.body as RelayRequest;

        // Basic request validation
        if (!chainId || !to || !data || !feesCacheId) {
          res.status(400).json({
            error: "Missing required fields: chainId, to, data, feesCacheId",
          });
          return;
        }

        console.log(
          `[http-api] Relay request: chain=${chainId} to=${to.slice(0, 10)}... ` +
            `data=${data.slice(0, 10)}... feesCacheId=${feesCacheId}`
        );

        const result = await this.privacyRelay.handleRelayRequest({
          chainId,
          to,
          data,
          feesCacheId,
        });

        res.json({ txHash: result.txHash, status: "pending" });
      } catch (e: any) {
        if (e instanceof RelayError) {
          console.warn(`[http-api] Relay rejected (${e.code}): ${e.message}`);
          const statusCode = this.errorCodeToStatus(e.code);
          res.status(statusCode).json({
            error: e.message,
            code: e.code,
          });
          return;
        }
        console.error("[http-api] Relay error:", e);
        res.status(500).json({
          error: "Internal relay error",
          code: "UNKNOWN_ERROR",
        });
      }
    });

    // GET /status/:txHash — Check transaction status
    this.app.get("/status/:txHash", async (req, res) => {
      try {
        const { txHash } = req.params;

        if (!txHash || !txHash.startsWith("0x") || txHash.length !== 66) {
          res.status(400).json({ error: "Invalid transaction hash" });
          return;
        }

        const status = await this.privacyRelay.getTransactionStatus(txHash);
        res.json(status);
      } catch (e: any) {
        console.error("[http-api] Status check error:", e);
        res.status(500).json({ error: "Failed to check status" });
      }
    });

    // GET / — Service banner. Intentionally distinct from /health; this is the cheap
    // "is the process alive" check, /health is the "is the scanner working" check.
    this.app.get("/", (_req, res) => {
      res.json({
        service: "armada-relayer",
        status: "running",
        endpoints: [
          "GET /fees",
          "POST /relay",
          "GET /status/:txHash",
          "GET /health",
        ],
      });
    });

    // GET /health — Per-chain scanner state. Mirrors the indexer's IndexerHealth shape
    // (`crowdfund-ui/packages/shared/src/lib/indexer.ts`) so a future operator dashboard can
    // share status-pill UX.
    //
    // HTTP status reflects the rollup status so load balancers / monitoring (k8s liveness
    // probes, uptime-kuma, etc.) can act on it without parsing JSON:
    //   healthy   → 200
    //   degraded  → 200 (still alive, surfacing transient issues in the body)
    //   stale     → 503 (scanner wedged but process up; restart needed)
    //   unhealthy → 503 (init failure or long-stale)
    this.app.get("/health", (_req, res) => {
      try {
        const health = this.getHealth();
        // Merge in-process counters at response time so the health snapshot reflects the
        // current values (counters live in PrivacyRelay + verifier; getHealth() comes from
        // cctp/iris relay modules which don't know about them).
        const merged: RelayerHealth = { ...health, counters: this.counters.snapshot() };
        const code =
          merged.status === "healthy" || merged.status === "degraded" ? 200 : 503;
        res.status(code).json(merged);
      } catch (e: any) {
        // getHealth itself throwing means a wiring bug (e.g. health provider not yet
        // initialised) — operators should never see this in steady state. Log server-side
        // with the error detail; respond with a properly-shaped RelayerHealth so consumers
        // parse one schema regardless of failure mode (a 503 with an ad-hoc body would
        // break monitoring that decodes the response as RelayerHealth).
        console.error("[http-api] /health threw:", e);
        const errorResponse: RelayerHealth = {
          status: "unhealthy",
          chains: [],
          generatedAt: Date.now(),
          counters: this.counters.snapshot(),
        };
        res.status(503).json(errorResponse);
      }
    });
  }

  /**
   * Map relay error codes to HTTP status codes
   */
  private errorCodeToStatus(code: string): number {
    switch (code) {
      case "INVALID_CHAIN":
      case "INVALID_TARGET":
      case "INVALID_DATA":
        return 400;
      case "FEE_TOO_LOW":
      case "FEE_EXPIRED":
      case "FEE_INSUFFICIENT":
        return 402; // Payment Required
      case "DUPLICATE_TX":
        return 409; // Conflict
      case "RELAYER_BUSY":
        return 503; // Service Unavailable
      case "GAS_ESTIMATION_FAILED":
        return 422; // Unprocessable Entity
      case "SUBMISSION_FAILED":
        return 502; // Bad Gateway
      default:
        return 500;
    }
  }

  /**
   * Start the HTTP server
   */
  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, () => {
        console.log(`[http-api] Listening on http://localhost:${this.port}`);
        console.log(`[http-api] Endpoints:`);
        console.log(`  GET  http://localhost:${this.port}/fees`);
        console.log(`  POST http://localhost:${this.port}/relay`);
        console.log(`  GET  http://localhost:${this.port}/status/:txHash`);
        console.log(`  GET  http://localhost:${this.port}/health`);
        resolve();
      });
    });
  }

  /**
   * Stop the HTTP server
   */
  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      console.log("[http-api] Server stopped");
    }
  }
}
