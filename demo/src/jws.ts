// Compact JWS (RFC 7515) with Ed25519 (alg "Ed25519", RFC 9864) on WebCrypto.
import { b64uDecode, b64uEncode, dec, enc } from "./util.ts";

export interface Signer { kid: string; key: CryptoKey }
export type KeyStore = Map<string, CryptoKey>;

export async function generateKeyPair(kid: string) {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const priv = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey;
  const pub = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as JsonWebKey;
  return { privateJwk: { ...priv, kid }, publicJwk: { ...pub, kid } };
}

export async function importSigner(jwk: JsonWebKey & { kid?: string }): Promise<Signer> {
  if (!jwk.kid || !jwk.d) throw new Error("private JWK needs kid and d");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
  return { kid: jwk.kid, key };
}

export async function importJwks(jwks: { keys: (JsonWebKey & { kid?: string })[] }): Promise<KeyStore> {
  const store: KeyStore = new Map();
  for (const k of jwks.keys) {
    if (!k.kid) continue;
    const { d: _d, ...pub } = k; // never keep a private part in the verifier
    store.set(k.kid, await crypto.subtle.importKey("jwk", pub, { name: "Ed25519" }, false, ["verify"]));
  }
  return store;
}

export async function signJws(signer: Signer, payload: object): Promise<string> {
  const head = b64uEncode(enc.encode(JSON.stringify({ alg: "Ed25519", kid: signer.kid })));
  const body = b64uEncode(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, signer.key, enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${b64uEncode(sig)}`;
}

export interface Verified { payload: any; kid: string; sig: string }

/** Throws on anything wrong: shape, alg, unknown kid, bad signature. */
export async function verifyJws(keys: KeyStore, jws: string): Promise<Verified> {
  const parts = jws.split(".");
  if (parts.length !== 3) throw new Error("malformed JWS");
  const [h, p, s] = parts;
  let header: any, payload: any, sig: Uint8Array;
  try {
    header = JSON.parse(dec.decode(b64uDecode(h)));
    payload = JSON.parse(dec.decode(b64uDecode(p)));
    sig = b64uDecode(s);
  } catch {
    throw new Error("malformed JWS");
  }
  if (header.alg !== "Ed25519") throw new Error(`unsupported alg ${header.alg}`);
  if (sig.length !== 64) throw new Error("bad signature length");
  const key = keys.get(header.kid);
  if (!key) throw new Error(`unknown kid ${header.kid}`);
  const ok = await crypto.subtle.verify({ name: "Ed25519" }, key, sig as BufferSource, enc.encode(`${h}.${p}`));
  if (!ok) throw new Error("signature invalid");
  return { payload, kid: header.kid, sig: s };
}
