// Web stand-in for the subset of expo-file-system's File/Directory/Paths API
// the app uses (media cache, decrypted media, attachments). Wired in
// metro.config.js for the web build only.
//
// Everything lives in memory as Blobs exposed through blob: URLs, so it
// renders and downloads like a file but is gone when the tab closes:
// decrypted photos and documents never land on a browser's disk.

type Entry = { blob?: Blob; alias?: string; url?: string };
const files = new Map<string, Entry>();
const dirs = new Set<string>();

const join = (base: string, name?: string) => (name ? `${base.replace(/\/+$/, "")}/${name}` : base);
const isExternal = (p: string) => /^(blob:|data:|https?:)/.test(p);

function urlFor(entry: Entry): string {
  if (entry.alias) return entry.alias;
  if (!entry.url && entry.blob) entry.url = URL.createObjectURL(entry.blob);
  return entry.url ?? "";
}
function drop(path: string) {
  const e = files.get(path);
  if (e?.url) URL.revokeObjectURL(e.url);
  files.delete(path);
}

export class Directory {
  readonly path: string;
  constructor(parent: Directory | string, name?: string) {
    this.path = join(typeof parent === "string" ? parent : parent.path, name);
  }
  get uri() {
    return this.path;
  }
  get exists() {
    return dirs.has(this.path) || [...files.keys()].some((p) => p.startsWith(this.path + "/"));
  }
  create(_opts?: unknown) {
    dirs.add(this.path);
  }
  delete() {
    for (const p of [...files.keys()]) if (p.startsWith(this.path + "/")) drop(p);
    for (const d of [...dirs]) if (d === this.path || d.startsWith(this.path + "/")) dirs.delete(d);
  }
  list(): (File | Directory)[] {
    const prefix = this.path + "/";
    return [...files.keys()]
      .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
      .map((p) => new File(p));
  }
  get size() {
    let total = 0;
    for (const [p, e] of files) if (p.startsWith(this.path + "/")) total += e.blob?.size ?? 0;
    return total;
  }
}

export class File {
  readonly path: string;
  constructor(parent: Directory | string, name?: string) {
    this.path = join(typeof parent === "string" ? parent : parent.path, name);
  }
  get uri() {
    if (isExternal(this.path)) return this.path;
    const e = files.get(this.path);
    return e ? urlFor(e) : this.path;
  }
  get exists() {
    return isExternal(this.path) || files.has(this.path);
  }
  get size() {
    return files.get(this.path)?.blob?.size ?? 0;
  }
  get name() {
    return this.path.split("/").pop() ?? "";
  }
  create(_opts?: unknown) {
    if (!files.has(this.path)) files.set(this.path, { blob: new Blob([]) });
  }
  write(content: Uint8Array | string) {
    drop(this.path);
    files.set(this.path, { blob: new Blob([content as BlobPart]) });
  }
  delete() {
    drop(this.path);
  }
  copy(target: File | Directory) {
    const dest = target instanceof Directory ? new File(target, this.name) : target;
    if (isExternal(this.path)) {
      drop(dest.path);
      files.set(dest.path, { alias: this.path });
      return;
    }
    const e = files.get(this.path);
    if (!e) throw new Error("File does not exist");
    drop(dest.path);
    files.set(dest.path, e.alias ? { alias: e.alias } : { blob: e.blob });
  }
  move(target: File | Directory) {
    const dest = target instanceof Directory ? new File(target, this.name) : target;
    const e = files.get(this.path);
    if (!e) throw new Error("File does not exist");
    files.delete(this.path);
    drop(dest.path);
    files.set(dest.path, e);
  }
  textSync(): string {
    throw new Error("Synchronous reads are not available on the web.");
  }
  async text(): Promise<string> {
    return await (await fetch(this.uri)).text();
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    return await (await fetch(this.uri)).arrayBuffer();
  }
}

export const Paths = {
  cache: new Directory("memfs://cache"),
  document: new Directory("memfs://document"),
};
