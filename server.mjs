import express from "express";
import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";

const HOST = process.env.CLOB_HOST || "https://clob.polymarket.com";
const CHAIN_ID = Number(process.env.CHAIN_ID || "137");

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function assertPrivateKey(pk) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    throw new Error("PRIVATE_KEY must be 0x + 64 hex chars (no spaces).");
  }
}

function authMiddleware(req, res, next) {
  const header = req.header("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || token !== process.env.SIGNER_TOKEN) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

function validateOrderInput(body) {
  const errors = [];
  const out = {};

  // REQUIRED
  if (!body?.tokenID) errors.push("tokenID is required");
  if (body?.price === undefined) errors.push("price is required");
  if (body?.size === undefined) errors.push("size is required");

  out.tokenID = String(body.tokenID);
  out.price = String(body.price);
  out.size = String(body.size);

  // OPTIONAL (defaults)
  out.side = String(body.side || "BUY").toUpperCase();
  if (!["BUY", "SELL"].includes(out.side)) errors.push("side must be BUY or SELL");

  out.feeRateBps = body.feeRateBps !== undefined ? String(body.feeRateBps) : "0";

  if (body.expiration !== undefined) {
    const exp = Number(body.expiration);
    if (!Number.isFinite(exp)) errors.push("expiration must be unix seconds (number)");
    else out.expiration = exp;
  }

  // optional override if you want:
  if (body.nonce !== undefined) out.nonce = String(body.nonce);

  return { errors, order: out };
}

async function postViaWorker(signedOrder) {
  const WORKER_URL = requireEnv("WORKER_URL");
  const WORKER_TOKEN = requireEnv("WORKER_TOKEN");

  const payload = {
    path: "/order",
    method: "POST",
    body: signedOrder,
  };

  const resp = await fetch(WORKER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${WORKER_TOKEN}`,
      Accept: "application/json",
      "User-Agent": "poly-signer-service/1.0",
    },
    body: JSON.stringify(payload),
  });

  const text = await resp.text();
  return { status: resp.status, body: text, contentType: resp.headers.get("Content-Type") || "text/plain" };
}

async function main() {
  // REQUIRED ENV
  const PRIVATE_KEY = requireEnv("PRIVATE_KEY");
  requireEnv("SIGNER_TOKEN");
  assertPrivateKey(PRIVATE_KEY);

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Public health (no auth)
  app.get("/health", (_req, res) => {
    res.json({ ok: true, host: HOST, chainId: CHAIN_ID });
  });

  // Protected routes from here
  app.use(authMiddleware);

  // signer + client
  const signer = new Wallet(PRIVATE_KEY);
  const clobClient = new ClobClient(HOST, CHAIN_ID, signer);

  // 1) SIGN ONLY -> returns signedOrder
  app.post("/sign", async (req, res) => {
    try {
      const { errors, order } = validateOrderInput(req.body);
      if (errors.length) return res.status(400).json({ ok: false, error: "Invalid input", errors });

      const signedOrder = await clobClient.createOrder(order);
      return res.json({ ok: true, signedOrder });
    } catch (e) {
      return res.status(500).json({ ok: false, error: "Sign failed", details: String(e) });
    }
  });

  // 2) SIGN + PLACE via Worker
  app.post("/place", async (req, res) => {
    try {
      const { errors, order } = validateOrderInput(req.body);
      if (errors.length) return res.status(400).json({ ok: false, error: "Invalid input", errors });

      const signedOrder = await clobClient.createOrder(order);

      // If worker env not set, return signedOrder so you can debug
      if (!process.env.WORKER_URL || !process.env.WORKER_TOKEN) {
        return res.status(400).json({
          ok: false,
          error: "WORKER_URL/WORKER_TOKEN not configured on signer",
          signedOrder,
        });
      }

      const result = await postViaWorker(signedOrder);

      // Return raw worker/CLOB response body
      res.status(result.status);
      res.setHeader("Content-Type", result.contentType);
      return res.send(result.body);
    } catch (e) {
      return res.status(500).json({ ok: false, error: "Place failed", details: String(e) });
    }
  });

  const port = Number(process.env.PORT || "3000");
  app.listen(port, () => console.log(`Signer service running on http://localhost:${port}`));
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
