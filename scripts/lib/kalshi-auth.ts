// Kalshi RSA-PSS request signing.
//
// Per Kalshi API docs: every authenticated request must include three headers:
//   KALSHI-ACCESS-KEY        - the access key id (UUID-like string)
//   KALSHI-ACCESS-TIMESTAMP  - current epoch time in MILLISECONDS as a string
//   KALSHI-ACCESS-SIGNATURE  - base64-encoded RSA-PSS-SHA256 signature of:
//                              "{timestamp}{METHOD}{path}"
//
// The path used in signing is the request path WITHOUT the query string and
// WITHOUT the host. Method is the uppercase HTTP verb. Timestamp must match
// the header value exactly.
//
// The private key is an RSA private key in PEM format (PKCS#8 or PKCS#1).
// We read it once and cache the imported KeyObject.

import { createSign, createPrivateKey, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

let cachedKey: KeyObject | null = null;
let cachedKeyPath: string | null = null;

function loadPrivateKey(pemPath: string): KeyObject {
  if (cachedKey && cachedKeyPath === pemPath) return cachedKey;
  const pem = readFileSync(pemPath, "utf8");
  cachedKey = createPrivateKey({
    key: pem,
    format: "pem",
  });
  cachedKeyPath = pemPath;
  return cachedKey;
}

export type KalshiCredentials = {
  accessKeyId: string;
  privateKeyPath: string;
};

export function readCredentialsFromEnv(): KalshiCredentials {
  const accessKeyId = process.env.KALSHI_API_KEY_ID;
  const privateKeyPath = process.env.KALSHI_API_PRIVATE_KEY_PATH;
  if (!accessKeyId) throw new Error("KALSHI_API_KEY_ID is not set");
  if (!privateKeyPath) throw new Error("KALSHI_API_PRIVATE_KEY_PATH is not set");
  return { accessKeyId, privateKeyPath };
}

export function signRequest(
  creds: KalshiCredentials,
  method: string,
  path: string,
  nowMs: number = Date.now(),
): { headers: Record<string, string>; timestamp: string } {
  const key = loadPrivateKey(creds.privateKeyPath);
  const timestamp = String(nowMs);
  const message = `${timestamp}${method.toUpperCase()}${path}`;
  const signer = createSign("RSA-SHA256");
  signer.update(message, "utf8");
  signer.end();
  const signature = signer.sign(
    {
      key,
      padding: 6, // RSA_PKCS1_PSS_PADDING
      saltLength: 32, // crypto.constants.RSA_PSS_SALTLEN_DIGEST
    },
    "base64",
  );
  return {
    headers: {
      "KALSHI-ACCESS-KEY": creds.accessKeyId,
      "KALSHI-ACCESS-TIMESTAMP": timestamp,
      "KALSHI-ACCESS-SIGNATURE": signature,
    },
    timestamp,
  };
}
