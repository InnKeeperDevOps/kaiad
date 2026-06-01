// File-tree + file-content helpers for the registry image viewer.
//
// OCI image layers are gzipped tar archives. To answer "what files
// does tag X contain" and "show me the contents of /etc/foo.conf in
// tag X", we walk each layer's tar in order, merge them with whiteout
// semantics, and re-walk to pull a single file's body when asked.
//
// Why a custom tar parser instead of `tar-stream`/`tar`?
//   - No new dependency in the API runtime image.
//   - We only need the read paths (list + extract one member). The
//     ustar + PAX (`x`) + GNU LongName (`L`/`K`) variants used by
//     docker / buildkit-produced layers are well-defined and fit in
//     ~100 lines.
//
// We DON'T extract anything to disk. The tree-walk pass throws away
// every body byte; the content-fetch pass reads bytes for exactly one
// target path. Both run streaming so a 5 GB layer never lands in
// memory.
//
// Whiteout semantics (AUFS, what OverlayFS-on-top mirrors in the
// docker layer format):
//   - `.wh.foo`           → deletes `foo` from the accumulated tree
//   - `.wh..wh..opq`      → opaque: deletes every accumulated entry
//                            under the same directory (later same-layer
//                            entries restore them as usual)
// Whiteouts are filtered out of the returned tree; they're not files
// the user wants to see.

import zlib from "node:zlib";
import { pipeline, Readable } from "node:stream";
import { promisify } from "node:util";

const PIPELINE = promisify(pipeline);

// ─── Tar header parsing ────────────────────────────────────────────────

export type TarTypeflag =
  | "file"
  | "hardlink"
  | "symlink"
  | "chardev"
  | "blockdev"
  | "directory"
  | "fifo"
  | "contiguous"
  | "pax"
  | "global-pax"
  | "gnu-longlink"
  | "gnu-longname"
  | "other";

export type TarHeader = {
  name: string;
  mode: number;
  uid: number;
  gid: number;
  size: number;
  mtime: number;
  typeflag: TarTypeflag;
  rawTypeflag: string;
  linkname: string;
};

function decodeTypeflag(c: string): TarTypeflag {
  switch (c) {
    case "0":
    case "\0":
      return "file";
    case "1":
      return "hardlink";
    case "2":
      return "symlink";
    case "3":
      return "chardev";
    case "4":
      return "blockdev";
    case "5":
      return "directory";
    case "6":
      return "fifo";
    case "7":
      return "contiguous";
    case "x":
      return "pax";
    case "g":
      return "global-pax";
    case "L":
      return "gnu-longname";
    case "K":
      return "gnu-longlink";
    default:
      return "other";
  }
}

function parseString(buf: Buffer): string {
  let end = buf.indexOf(0);
  if (end === -1) end = buf.length;
  return buf.subarray(0, end).toString("utf8");
}

function parseOctal(buf: Buffer): number {
  // Tar numerics are NUL-/space-padded octal strings. Wide files can
  // use the GNU "base-256" extension (MSB set on the first byte) but
  // it's vanishingly rare in container layers; we fall back to 0 if
  // we ever see one rather than mis-parse.
  if (buf.length > 0 && (buf[0] & 0x80) !== 0) return 0;
  let s = "";
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (c === 0 || c === 0x20) {
      if (s.length === 0) continue;
      break;
    }
    s += String.fromCharCode(c);
  }
  if (!s) return 0;
  const n = parseInt(s, 8);
  return Number.isFinite(n) ? n : 0;
}

function isZero(buf: Buffer): boolean {
  for (let i = 0; i < buf.length; i++) if (buf[i] !== 0) return false;
  return true;
}

function parseHeader(h: Buffer): TarHeader {
  const name = parseString(h.subarray(0, 100));
  const mode = parseOctal(h.subarray(100, 108));
  const uid = parseOctal(h.subarray(108, 116));
  const gid = parseOctal(h.subarray(116, 124));
  const size = parseOctal(h.subarray(124, 136));
  const mtime = parseOctal(h.subarray(136, 148));
  const rawTypeflag = String.fromCharCode(h[156] || 0);
  const linkname = parseString(h.subarray(157, 257));
  const magic = h.subarray(257, 263).toString("ascii");
  let prefix = "";
  if (magic.startsWith("ustar")) prefix = parseString(h.subarray(345, 500));
  const fullName = prefix ? `${prefix}/${name}` : name;
  return {
    name: fullName,
    mode,
    uid,
    gid,
    size,
    mtime,
    typeflag: decodeTypeflag(rawTypeflag),
    rawTypeflag,
    linkname
  };
}

// PAX extended-header records: "<len> <key>=<value>\n" repeating. `len`
// is the byte count of the WHOLE record including the length number,
// the space, the key, the '=', the value, and the trailing newline.
function parsePax(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < buf.length) {
    let lenEnd = i;
    while (lenEnd < buf.length && buf[lenEnd] !== 0x20) lenEnd++;
    if (lenEnd >= buf.length) break;
    const len = parseInt(buf.subarray(i, lenEnd).toString("ascii"), 10);
    if (!Number.isFinite(len) || len <= 0 || i + len > buf.length) break;
    const record = buf.subarray(i, i + len);
    const sep = record.indexOf(0x3d, lenEnd - i + 1);
    if (sep > -1) {
      const key = record.subarray(lenEnd - i + 1, sep).toString("utf8");
      // Value is everything after '=' up to (but not including) the
      // trailing newline at position len-1.
      const value = record.subarray(sep + 1, len - 1).toString("utf8");
      out[key] = value;
    }
    i += len;
  }
  return out;
}

// ─── StreamReader: pull N bytes, skip N bytes ──────────────────────────

class StreamReader {
  private it: AsyncIterator<Buffer>;
  private buf: Buffer = Buffer.alloc(0);
  private done = false;
  constructor(s: NodeJS.ReadableStream) {
    this.it = (s as unknown as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
  }
  private async fill(n: number): Promise<void> {
    while (!this.done && this.buf.length < n) {
      const r = await this.it.next();
      if (r.done) {
        this.done = true;
        return;
      }
      const chunk = (r.value as Buffer | string) instanceof Buffer
        ? (r.value as Buffer)
        : Buffer.from(r.value as Uint8Array);
      this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    }
  }
  /** Read exactly n bytes; returns null on EOF, partial buffer on truncation. */
  async readExact(n: number): Promise<Buffer | null> {
    await this.fill(n);
    if (this.buf.length === 0) return null;
    if (this.buf.length < n) {
      const out = this.buf;
      this.buf = Buffer.alloc(0);
      return out;
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
  /** Discard exactly n bytes (or up to EOF). */
  async skip(n: number): Promise<void> {
    let remaining = n;
    while (remaining > 0) {
      const take = Math.min(remaining, this.buf.length);
      if (take > 0) {
        this.buf = this.buf.subarray(take);
        remaining -= take;
        if (remaining === 0) return;
      }
      await this.fill(Math.min(remaining, 64 * 1024));
      if (this.buf.length === 0) return;
    }
  }
}

const BLOCK = 512;
function padTo512(n: number): number {
  return (BLOCK - (n % BLOCK)) % BLOCK;
}

// ─── Walk one tar stream ───────────────────────────────────────────────

/**
 * Stream-walk a (gzipped) tar layer. The visitor is called with each
 * file/dir/symlink/etc. header; it must return either "skip" (discard
 * the body) or "body" (the body will be buffered up to `bodyCap` and
 * delivered as a Buffer in the callback). PAX/GNU long-name records
 * are consumed transparently — visitors never see them.
 *
 * The walker also handles end-of-archive (two zero blocks) and tail
 * padding to the 512-byte boundary so consecutive entries align.
 */
export async function walkLayer(
  layerStream: NodeJS.ReadableStream,
  visit: (
    header: TarHeader,
    body: { read: () => Promise<Buffer> }
  ) => Promise<"skip" | "consumed">
): Promise<void> {
  const reader = new StreamReader(layerStream.pipe(zlib.createGunzip()));
  let nextName: string | null = null;
  let nextLinkname: string | null = null;
  let nextSize: number | null = null;
  let zeroBlocks = 0;
  while (true) {
    const headerBuf = await reader.readExact(BLOCK);
    if (!headerBuf || headerBuf.length < BLOCK) return;
    if (isZero(headerBuf)) {
      zeroBlocks++;
      if (zeroBlocks >= 2) return;
      continue;
    }
    zeroBlocks = 0;
    const h = parseHeader(headerBuf);
    let size = h.size;
    if (h.typeflag === "pax" || h.typeflag === "global-pax") {
      const body = (await reader.readExact(size)) ?? Buffer.alloc(0);
      await reader.skip(padTo512(size));
      if (h.typeflag === "pax") {
        const pax = parsePax(body);
        if (typeof pax.path === "string") nextName = pax.path;
        if (typeof pax.linkpath === "string") nextLinkname = pax.linkpath;
        if (typeof pax.size === "string") {
          const n = parseInt(pax.size, 10);
          if (Number.isFinite(n)) nextSize = n;
        }
      }
      continue;
    }
    if (h.typeflag === "gnu-longname") {
      const body = (await reader.readExact(size)) ?? Buffer.alloc(0);
      await reader.skip(padTo512(size));
      nextName = parseString(body);
      continue;
    }
    if (h.typeflag === "gnu-longlink") {
      const body = (await reader.readExact(size)) ?? Buffer.alloc(0);
      await reader.skip(padTo512(size));
      nextLinkname = parseString(body);
      continue;
    }
    if (nextName != null) {
      h.name = nextName;
      nextName = null;
    }
    if (nextLinkname != null) {
      h.linkname = nextLinkname;
      nextLinkname = null;
    }
    if (nextSize != null) {
      size = nextSize;
      h.size = nextSize;
      nextSize = null;
    }
    let consumed = false;
    const result = await visit(h, {
      read: async () => {
        consumed = true;
        const buf = (await reader.readExact(size)) ?? Buffer.alloc(0);
        await reader.skip(padTo512(size));
        return buf;
      }
    });
    if (result === "skip" && !consumed) {
      await reader.skip(size + padTo512(size));
    } else if (result === "consumed" && !consumed) {
      // Visitor said it consumed but didn't call read() — advance past
      // the body anyway so the next header lands on a 512 boundary.
      await reader.skip(size + padTo512(size));
    }
  }
}

// ─── File tree merge across layers ─────────────────────────────────────

export type FileTreeEntry = {
  /** POSIX-style path with leading "/". Always absolute. */
  path: string;
  /** Last-writer-wins type after whiteouts are applied. */
  type: "file" | "directory" | "symlink" | "hardlink" | "other";
  /** Size in bytes (0 for non-files). */
  size: number;
  mode: number;
  uid: number;
  gid: number;
  mtime: number;
  /** Resolved link target for symlinks/hardlinks. */
  linkTarget?: string;
  /**
   * Index into the manifest's layer list where this entry lives.
   * The content endpoint uses this to know which blob to re-walk.
   */
  layerIdx: number;
};

function normalizeName(raw: string): string {
  let s = raw;
  // Drop ./ prefix; strip any leading "/" since we'll re-add one.
  while (s.startsWith("./")) s = s.slice(2);
  while (s.startsWith("/")) s = s.slice(1);
  return "/" + s;
}

function isWhiteout(basename: string): boolean {
  return basename.startsWith(".wh.");
}

function splitParentBase(path: string): { parent: string; base: string } {
  const i = path.lastIndexOf("/");
  if (i <= 0) return { parent: "/", base: path.slice(1) };
  return { parent: path.slice(0, i) || "/", base: path.slice(i + 1) };
}

function mapType(t: TarTypeflag): FileTreeEntry["type"] {
  switch (t) {
    case "file":
    case "contiguous":
      return "file";
    case "directory":
      return "directory";
    case "symlink":
      return "symlink";
    case "hardlink":
      return "hardlink";
    default:
      return "other";
  }
}

/**
 * Walk every layer in order, applying whiteouts. Returns a Map keyed
 * by absolute path → entry. Directories are included as their own
 * entries so the UI can render an empty folder.
 */
export async function buildImageFileTree(
  layers: Array<{ idx: number; openStream: () => Promise<NodeJS.ReadableStream> }>
): Promise<Map<string, FileTreeEntry>> {
  const tree = new Map<string, FileTreeEntry>();
  for (const { idx, openStream } of layers) {
    const stream = await openStream();
    await walkLayer(stream, async (h) => {
      const path = normalizeName(h.name);
      const { parent, base } = splitParentBase(path);
      if (base === ".wh..wh..opq") {
        // Opaque whiteout: wipe everything under `parent` accumulated
        // up to this point. The directory itself stays.
        const prefix = parent.endsWith("/") ? parent : parent + "/";
        for (const key of [...tree.keys()]) {
          if (key.startsWith(prefix) && key !== parent) tree.delete(key);
        }
        return "skip";
      }
      if (isWhiteout(base)) {
        // Single whiteout: delete `<parent>/<base.slice(4)>` and any
        // descendants from the accumulated tree.
        const removed = `${parent === "/" ? "" : parent}/${base.slice(4)}`;
        tree.delete(removed);
        const prefix = removed.endsWith("/") ? removed : removed + "/";
        for (const key of [...tree.keys()]) {
          if (key.startsWith(prefix)) tree.delete(key);
        }
        return "skip";
      }
      const type = mapType(h.typeflag);
      // Trim trailing slash so directory keys are stable.
      const cleaned = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
      tree.set(cleaned, {
        path: cleaned,
        type,
        size: type === "file" ? h.size : 0,
        mode: h.mode,
        uid: h.uid,
        gid: h.gid,
        mtime: h.mtime,
        linkTarget: type === "symlink" || type === "hardlink" ? h.linkname || undefined : undefined,
        layerIdx: idx
      });
      return "skip";
    });
  }
  return tree;
}

// ─── Extract one file's body from a specific layer ─────────────────────

/**
 * Walk `layerStream` and return the body for the entry at `targetPath`
 * (compared after normalization). Caps the buffered body at `maxBytes`
 * to protect the API process; on overflow returns the first `maxBytes`
 * and `truncated: true`.
 */
export async function readFileFromLayer(
  layerStream: NodeJS.ReadableStream,
  targetPath: string,
  maxBytes: number
): Promise<{ body: Buffer; size: number; truncated: boolean; header: TarHeader } | null> {
  const normTarget = normalizeName(targetPath);
  let found: { body: Buffer; size: number; truncated: boolean; header: TarHeader } | null = null;
  await walkLayer(layerStream, async (h, body) => {
    const path = normalizeName(h.name);
    if (path === normTarget && (h.typeflag === "file" || h.typeflag === "contiguous")) {
      const full = await body.read();
      const truncated = full.length > maxBytes;
      found = {
        body: truncated ? full.subarray(0, maxBytes) : full,
        size: h.size,
        truncated,
        header: h
      };
      return "consumed";
    }
    return "skip";
  });
  return found;
}

// Re-export pipeline so callers using stream wiring don't need their own.
export { PIPELINE };
