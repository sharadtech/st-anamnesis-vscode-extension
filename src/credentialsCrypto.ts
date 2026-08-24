import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import { config, fetchAuthUser } from "./api";

export interface CredentialEntry {
  key: string;
  type: "text" | "password";
  value: string;
}

export interface CipherBlob {
  v: number;
  alg: string;
  kdf: string;
  kdfSalt: string;
  keyId?: string;
  keyName?: string;
  wrappedDek: string;
  wrapIv: string;
  wrapTag: string;
  iv: string;
  tag: string;
  data: string;
}

export interface EncryptionContext {
  clientId: string;
  userId: string;
  secretKey: string;
  keyId: string;
  keyName: string;
}

export async function getEncryptionContext(): Promise<EncryptionContext> {
  const { clientId, secretKey } = config();
  if (!clientId || !secretKey) {
    throw new Error("Set Client Id and Secret Key in Anamnesis Settings before saving credentials.");
  }
  const user = await fetchAuthUser();
  if (!user?.userId) {
    throw new Error("Could not resolve the signed-in Anamnesis user.");
  }
  return {
    clientId,
    userId: user.userId,
    secretKey,
    keyId: user.keyId || "",
    keyName: user.keyName || "",
  };
}

const SCRYPT_OPTS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LEN = 32;
const IV_LEN = 12;

const b64 = (buf: Buffer): string => buf.toString("base64");
const fromB64 = (s: string): Buffer => Buffer.from(s, "base64");

const aadBuffer = (ctx: EncryptionContext): Buffer =>
  Buffer.from(`${ctx.clientId}:${ctx.userId}`, "utf8");

const deriveKek = (secretKey: string, salt: Buffer): Buffer =>
  scryptSync(secretKey, salt, KEY_LEN, SCRYPT_OPTS);

function aesGcmEncrypt(
  key: Buffer,
  plaintext: Buffer,
  aad: Buffer
): { iv: Buffer; tag: Buffer; data: Buffer } {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), data };
}

function aesGcmDecrypt(
  key: Buffer,
  iv: Buffer,
  tag: Buffer,
  data: Buffer,
  aad: Buffer
): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

export function encryptCredentialSet(
  entries: CredentialEntry[],
  ctx: EncryptionContext
): CipherBlob {
  if (!ctx.clientId || !ctx.userId || !ctx.secretKey) {
    throw new Error("Client Id, user id, and Secret Key are required to encrypt credentials.");
  }
  const aad = aadBuffer(ctx);
  const kdfSalt = randomBytes(16);
  const kek = deriveKek(ctx.secretKey, kdfSalt);
  const dek = randomBytes(KEY_LEN);

  const wrapped = aesGcmEncrypt(kek, dek, aad);
  const payload = aesGcmEncrypt(
    dek,
    Buffer.from(JSON.stringify(entries), "utf8"),
    aad
  );

  return {
    v: 1,
    alg: "aes-256-gcm",
    kdf: "scrypt",
    kdfSalt: b64(kdfSalt),
    keyId: ctx.keyId || "",
    keyName: ctx.keyName || "",
    wrappedDek: b64(wrapped.data),
    wrapIv: b64(wrapped.iv),
    wrapTag: b64(wrapped.tag),
    iv: b64(payload.iv),
    tag: b64(payload.tag),
    data: b64(payload.data),
  };
}

export function decryptCredentialSet(
  cipher: CipherBlob,
  ctx: EncryptionContext
): CredentialEntry[] {
  if (!ctx.clientId || !ctx.userId || !ctx.secretKey) {
    throw new Error("Client Id, user id, and Secret Key are required to decrypt credentials.");
  }
  if (!cipher || cipher.v !== 1 || cipher.alg !== "aes-256-gcm" || cipher.kdf !== "scrypt") {
    throw new Error("Unsupported credential cipher format.");
  }
  const aad = aadBuffer(ctx);
  try {
    const kek = deriveKek(ctx.secretKey, fromB64(cipher.kdfSalt));
    const dek = aesGcmDecrypt(
      kek,
      fromB64(cipher.wrapIv),
      fromB64(cipher.wrapTag),
      fromB64(cipher.wrappedDek),
      aad
    );
    const plaintext = aesGcmDecrypt(
      dek,
      fromB64(cipher.iv),
      fromB64(cipher.tag),
      fromB64(cipher.data),
      aad
    );
    const parsed = JSON.parse(plaintext.toString("utf8"));
    if (!Array.isArray(parsed)) {
      throw new Error("Decrypted payload is not a credential list.");
    }
    return parsed.map((row: Record<string, unknown>) => ({
      key: String(row.key ?? "").trim(),
      type: row.type === "password" ? "password" : "text",
      value: String(row.value ?? ""),
    }));
  } catch (err) {
    const keyHint = cipher.keyName ? ` (encrypted with key "${cipher.keyName}")` : "";
    throw new Error(
      `Could not decrypt this credential set${keyHint}. ` +
        `Use the same Secret Key that was configured when it was saved. ` +
        `${err instanceof Error ? err.message : ""}`
    );
  }
}
