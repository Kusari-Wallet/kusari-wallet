// The coordinator's JSON for credentials, as Wasabi Wallet writes and reads it.
import { CredentialsRequest, CredentialsResponse, IssuerParams, Mac, Point, Proof, pointBytes, pointFrom, scalarBytes, scalarFrom } from './credentials';

const HEX = /^[0-9a-fA-F]*$/;
export const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex').toUpperCase();
export function fromHex(s: unknown, len?: number): Uint8Array {
  if (typeof s !== 'string' || s.length % 2 || !HEX.test(s)) throw new Error('The coordinator sent something that is not hex.');
  const b = Uint8Array.from(Buffer.from(s, 'hex'));
  if (len !== undefined && b.length !== len) throw new Error('The coordinator sent a value of the wrong length.');
  return b;
}
const ge = (p: Point) => toHex(pointBytes(p));
const sc = (s: bigint) => toHex(scalarBytes(s));
const readGe = (s: unknown): Point => pointFrom(fromHex(s, 33));
function readSc(s: unknown): bigint {
  const v = scalarFrom(fromHex(s, 32));
  if (v === null) throw new Error('The coordinator sent a scalar out of range.');
  return v;
}
function list<T>(v: unknown, max: number, f: (x: unknown) => T): T[] {
  if (!Array.isArray(v) || v.length > max) throw new Error('The coordinator sent a list that is too long or missing.');
  return v.map(f);
}

const proofJson = (p: Proof) => ({ PublicNonces: p.nonces.map(ge), Responses: p.responses.map(sc) });
const MAX_NONCES = 2 * 51 + 1;
const MAX_RESPONSES = 3 * 51 + 1;
const readProof = (v: any): Proof => ({ nonces: list(v?.PublicNonces, MAX_NONCES, readGe), responses: list(v?.Responses, MAX_RESPONSES, readSc) });

export function requestJson(r: CredentialsRequest) {
  return {
    Delta: Number(r.delta),
    Presented: r.presented.map((p) => ({ Ca: ge(p.Ca), Cx0: ge(p.Cx0), Cx1: ge(p.Cx1), CV: ge(p.CV), S: ge(p.S) })),
    Requested: r.requested.map((q) => ({ Ma: ge(q.Ma), BitCommitments: q.bits.map(ge) })),
    Proofs: r.proofs.map(proofJson),
  };
}

export function readResponse(v: any): CredentialsResponse {
  const issued = list(v?.issuedCredentials, 2, (m: any): Mac => ({ t: readSc(m?.T), V: readGe(m?.V) }));
  return { issued, proofs: list(v?.proofs, 2, readProof) };
}

export function readIssuerParams(v: any): IssuerParams {
  return { Cw: readGe(v?.cw), I: readGe(v?.i) };
}

/** For a stand-in coordinator in tests: the request back from JSON. */
export function readRequest(v: any): CredentialsRequest {
  return {
    delta: BigInt(v?.Delta ?? 0),
    presented: list(v?.Presented ?? [], 2, (p: any) => ({ Ca: readGe(p.Ca), Cx0: readGe(p.Cx0), Cx1: readGe(p.Cx1), CV: readGe(p.CV), S: readGe(p.S) })),
    requested: list(v?.Requested, 2, (q: any) => ({ Ma: readGe(q.Ma), bits: list(q.BitCommitments, 51, readGe) })),
    proofs: list(v?.Proofs, 5, readProof),
  };
}
export const responseJson = (r: CredentialsResponse) => ({ issuedCredentials: r.issued.map((m) => ({ T: sc(m.t), V: ge(m.V) })), proofs: r.proofs.map(proofJson) });
