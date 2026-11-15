import { createHash, randomBytes } from "crypto";

export function generateToken() {
  const raw = randomBytes(32).toString("hex");
  const hashed = createHash("sha256").update(raw).digest("hex");
  return { raw, hashed };
}

export function hashToken(raw: string) {
  return createHash("sha256").update(raw).digest("hex");
}
