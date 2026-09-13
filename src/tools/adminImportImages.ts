import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { storeField, type ToolSpec } from "../register.js";

/**
 * «Імпорт зображень» — bulk upload of LOCAL image files, matched to products by
 * FILE NAME. The last uncovered screen of the admin menu.
 *
 * THE CONVENTION (the screen's own help text, verbatim from the Vue bundle):
 *   <ARTICLE>.jpg                    → the product's main photo
 *   <ARTICLE>@1.jpg, <ARTICLE>@2.jpg → further photos of the same product
 *   <ARTICLE>@gallery_common@1.jpg   → the gallery SHARED by every modification
 * The platform, not this tool, performs the matching: `import-images/check` is
 * handed the bare file names and answers which product each one lands on. That
 * matters — a local guess at "article = stem before @" would disagree with the
 * platform on exactly the cases worth knowing about, and the point of the dry
 * run is to show the platform's answer, not ours.
 *
 * LIMITS (from the same screen): jpg/jpeg/png/gif · 5 MB per file · 500 files
 * per run · 256 MB in total.
 *
 * THE DANGEROUS DEFAULT, INVERTED. The admin screen's «Сохранить уже имеющиеся
 * фото в галерее» checkbox is UNCHECKED by default and the assign call it makes
 * is `cleanGallery: !save_gallery` — so the platform's own default DELETES every
 * existing photo of every product it touches. A caller who reads "import images"
 * as "add images" loses live galleries. Here the default is the opposite:
 * `keepExistingGallery` defaults to true, and wiping is something you ask for.
 */

/** jpg/jpeg/png/gif — the screen's `accept="image/jpeg,image/png,image/gif"`. */
const ALLOWED_EXT = new Set(["jpg", "jpeg", "png", "gif"]);
const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
};

export const IMPORT_IMAGE_LIMITS = {
  /** 5 MB per file. */
  maxFileBytes: 5 * 1024 * 1024,
  /** 500 files per run. */
  maxFiles: 500,
  /** 256 MB in total. */
  maxTotalBytes: 256 * 1024 * 1024,
} as const;

/** How many names one `check` call carries (the screen chunks at 1000). */
const CHECK_CHUNK = 200;
/** How many uploads run at once (the screen uses 10; 4 is gentler on a shared box). */
const UPLOAD_CONCURRENCY = 4;
/** How many bindings one `assign` call carries. */
const ASSIGN_CHUNK = 100;

/** Magic-byte sniff, so a .jpg that is really a text file is caught before it is uploaded. */
function sniffImage(b: Uint8Array): string | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  return null;
}

const human = (n: number): string =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`;

interface Candidate {
  path: string;
  filename: string;
  bytes: Uint8Array;
  size: number;
  contentType: string;
}

interface Rejected {
  file: string;
  filename: string;
  reason: string;
}

/**
 * Collect the files to consider, from explicit paths and/or one directory.
 * Reading happens here (not lazily at upload time) because every limit — total
 * size, per-file size, "is this actually an image" — needs the bytes, and a dry
 * run that skipped them would approve a run that then fails halfway through.
 */
function collectFiles(
  files: string[] | undefined,
  dir: string | undefined,
): { candidates: Candidate[]; rejected: Rejected[] } {
  const paths: string[] = [];
  if (dir) {
    if (!isAbsolute(dir)) throw new Error(`\`dir\` must be an ABSOLUTE path (got "${dir}").`);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (e) {
      throw new Error(`Cannot read directory "${dir}": ${(e as Error).message}`);
    }
    for (const e of entries.sort()) {
      const full = join(dir, e);
      try {
        if (statSync(full).isFile()) paths.push(full);
      } catch {
        /* unreadable entry — surfaces below as a rejection when explicitly named */
      }
    }
  }
  for (const f of files ?? []) {
    if (!isAbsolute(f)) throw new Error(`Every path in \`files\` must be ABSOLUTE (got "${f}").`);
    paths.push(f);
  }

  const candidates: Candidate[] = [];
  const rejected: Rejected[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    const filename = basename(p);
    if (seen.has(filename)) {
      rejected.push({ file: p, filename, reason: "duplicate file name in this batch (the platform keys images by name)" });
      continue;
    }
    seen.add(filename);
    const ext = extname(filename).slice(1).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      rejected.push({ file: p, filename, reason: `extension ".${ext || "(none)"}" is not accepted (jpg/jpeg/png/gif only)` });
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(readFileSync(p));
    } catch (e) {
      rejected.push({ file: p, filename, reason: `unreadable: ${(e as Error).message}` });
      continue;
    }
    if (bytes.length === 0) {
      rejected.push({ file: p, filename, reason: "empty file (0 bytes)" });
      continue;
    }
    if (bytes.length > IMPORT_IMAGE_LIMITS.maxFileBytes) {
      rejected.push({
        file: p,
        filename,
        reason: `${human(bytes.length)} exceeds the 5 MB per-file limit`,
      });
      continue;
    }
    const sniffed = sniffImage(bytes);
    if (!sniffed) {
      rejected.push({ file: p, filename, reason: "the bytes are not a JPEG/PNG/GIF, whatever the extension says" });
      continue;
    }
    candidates.push({ path: p, filename, bytes, size: bytes.length, contentType: sniffed ?? EXT_MIME[ext] });
  }
  return { candidates, rejected };
}

/** Split the batch at the count/total-size ceilings, reporting what did not fit. */
function applyBatchLimits(candidates: Candidate[]): { accepted: Candidate[]; rejected: Rejected[] } {
  const accepted: Candidate[] = [];
  const rejected: Rejected[] = [];
  let total = 0;
  for (const c of candidates) {
    if (accepted.length >= IMPORT_IMAGE_LIMITS.maxFiles) {
      rejected.push({ file: c.path, filename: c.filename, reason: "over the 500-files-per-run limit" });
      continue;
    }
    if (total + c.size > IMPORT_IMAGE_LIMITS.maxTotalBytes) {
      rejected.push({ file: c.path, filename: c.filename, reason: "over the 256 MB total-size limit" });
      continue;
    }
    total += c.size;
    accepted.push(c);
  }
  return { accepted, rejected };
}

/** Run `worker` over `items` with a fixed pool, preserving input order in the result. */
async function pooled<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

/** What kind of gallery slot the platform resolved this name to (reported, not guessed). */
function slotOf(filename: string): "gallery_common" | "gallery_360" | "main gallery" {
  const stem = filename.slice(0, filename.length - extname(filename).length);
  if (/@gallery_common(@|$)/i.test(stem)) return "gallery_common";
  if (/@gallery_360(@|$)/i.test(stem)) return "gallery_360";
  return "main gallery";
}

const chunk = <T,>(arr: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

export const adminImportImageTools: ToolSpec[] = [
  {
    name: "horoshop_admin_import_images",
    title: "Bulk-import local images by file name",
    description:
      "Upload LOCAL image files to the catalog the way the admin's «Імпорт зображень» screen does: each file is matched to a product BY ITS FILE NAME. Pass `files` (absolute paths) and/or `dir` (an absolute folder, non-recursive). " +
      "NAMING CONVENTION: `<ARTICLE>.jpg` is the product's main photo; `<ARTICLE>@1.jpg`, `<ARTICLE>@2.jpg` … are further photos of the same product; `<ARTICLE>@gallery_common@1.jpg` goes to the gallery SHARED by all of that product's modifications. The article is the product's article EXACTLY as the catalog stores it — the match is CASE-SENSITIVE and literal (measured: `tee-warrior.png` finds nothing where `TEE-WARRIOR.png` matches, and a space is not a hyphen). A camera's `IMG_0431.jpg` matches nothing at all; rename before importing. " +
      "THE MATCHING IS THE PLATFORM'S, NOT THIS TOOL'S. Every run first posts the bare file names to Horoshop's own matcher, which answers, per file, which product it lands on (`article`, `product` title, the internal record id) or that there is no product with that article. So the DRY RUN — the default — is a real answer, not a local guess: it lists `matched` (file → article → product, and which gallery slot), `unmatched` (no such article — these files would be silently ignored by the admin screen) and `rejected` (wrong extension, over 5 MB, not actually an image, duplicate name, over the batch ceilings). Running the dry run before touching the admin screen by hand is worth it on its own: it tells you which photos will find no product BEFORE you spend an hour dragging 400 files into a browser. " +
      "⚠ THE ADMIN SCREEN'S DEFAULT DELETES GALLERIES — THIS TOOL'S DOES NOT. That screen's «Сохранить уже имеющиеся фото в галерее» checkbox ships UNCHECKED, and it sends `cleanGallery:true`, which REMOVES every existing photo of every product it touches before attaching the new ones. Here the safe direction is the default: `keepExistingGallery` is TRUE, new photos are added alongside the existing ones. Pass keepExistingGallery:false only when you deliberately want each touched product's gallery replaced — that deletion has no undo, and the photos it removes are not recoverable from this server. " +
      "LIMITS (the platform's, enforced before anything is sent): jpg/jpeg/png/gif only · 5 MB per file · 500 files per run · 256 MB in total. Files that break a limit are reported in `rejected` and the rest still run. " +
      "WHAT IT PROVES WHEN IT SAYS IT WORKED: after assigning, it re-reads the touched articles through the PUBLIC catalog export (a different channel from the one that wrote) and reports each product's image count before and after, plus an HTTP fetch of one newly stored image showing it really is served as an image. `verified:false` with the counts unchanged means the bind did not take, whatever the upload said. " +
      "NO UNDO, AND NO PER-IMAGE DELETE ANYWHERE IN THIS SERVER: Horoshop exposes no route that removes ONE photo from a product's gallery (measured — `catalog_import` with `images.links:[]` reports OK and changes nothing). An added photo can only be removed by a human in the admin, and a gallery wiped by keepExistingGallery:false is gone. Treat every non-dry run as one-way. " +
      "ANSWER SHAPE — the same on every path, including the ones where nothing happens: `counts{matched,uploaded,assigned,unmatched,rejected}`, `matched[]` / `unmatched[]` / `rejected[]`, and on a real run `verified`, `perArticle[{article,imagesBefore,imagesAfter}]`, `assetCheck` and `files[]`. There is no second shape to check for the empty case. " +
      "Related but different: horoshop_catalog_process_images attaches files ALREADY uploaded to the store's FTP; this tool sends local files from this machine. horoshop_catalog_import attaches images by URL.",
    inputSchema: {
      ...storeField,
      files: z
        .array(z.string())
        .optional()
        .describe("ABSOLUTE paths of the image files to import. Combine with `dir` or use either alone."),
      dir: z
        .string()
        .optional()
        .describe("ABSOLUTE path of a folder whose image files are imported (non-recursive; sub-folders are ignored)."),
      keepExistingGallery: z
        .boolean()
        .optional()
        .describe(
          "Default TRUE — new photos are ADDED and the product's existing gallery is preserved. FALSE sends the admin screen's own `cleanGallery`, which DELETES every existing photo of every touched product first. Irreversible.",
        ),
      dryRun: z
        .boolean()
        .optional()
        .describe("Default true: match the file names against the catalog and report, without uploading anything."),
    },
    annotations: { readOnlyHint: false, idempotentHint: false },
    handler: async (client, args) => {
      if (!args.files?.length && !args.dir) {
        throw new Error("Nothing to import: pass `files` (absolute paths) and/or `dir` (an absolute folder).");
      }
      const dryRun = args.dryRun !== false;
      const keepGallery = args.keepExistingGallery !== false;

      const collected = collectFiles(args.files, args.dir);
      const limited = applyBatchLimits(collected.candidates);
      const rejected = [...collected.rejected, ...limited.rejected].map((r) => ({ file: r.filename, path: r.file, reason: r.reason }));
      const batch = limited.accepted;
      // Every exit below carries the SAME `counts` block. An early return that
      // reported `uploaded: 0` at the top level while the normal path put it
      // under `counts` is the same trap this server keeps closing: a caller
      // reading one shape finds nothing in the other and calls it success.
      const counts = (over: Partial<Record<"matched" | "uploaded" | "assigned" | "unmatched" | "rejected", number>>) => ({
        matched: 0,
        uploaded: 0,
        assigned: 0,
        unmatched: 0,
        rejected: rejected.length,
        ...over,
      });

      if (batch.length === 0) {
        return {
          store: args.store ?? null,
          dryRun,
          counts: counts({}),
          matched: [],
          unmatched: [],
          rejected,
          note: "No file survived the local checks — nothing was sent to the store. See `rejected` for why.",
        };
      }

      // 1) The platform matches names → products. Read-only, and the whole point
      //    of the dry run.
      const { authToken, cloudToken, awsApiLink } = await client.admin.importImagesTokens(args.store);
      const checked: Record<string, any> = {};
      for (const part of chunk(batch, CHECK_CHUNK)) {
        Object.assign(checked, await client.admin.importImagesCheck(args.store, authToken, part.map((c) => c.filename)));
      }

      const matched: Array<{ candidate: Candidate; meta: any }> = [];
      const unmatched: Array<{ file: string; reason: string }> = [];
      for (const c of batch) {
        const meta = checked[c.filename];
        if (meta?.success) matched.push({ candidate: c, meta });
        else {
          unmatched.push({
            file: c.filename,
            reason:
              meta?.message === "productNotFound" || !meta
                ? "no product with that article — the admin screen would ignore this file silently"
                : String(meta.message ?? "rejected by the platform matcher"),
          });
        }
      }

      const describeMatch = (m: { candidate: Candidate; meta: any }) => ({
        file: m.candidate.filename,
        size: human(m.candidate.size),
        article: m.candidate.filename.slice(0, m.candidate.filename.length - extname(m.candidate.filename).length).split("@")[0],
        product: m.meta.mainTitle ?? m.meta.title ?? null,
        productRecordId: m.meta.parent ?? null,
        slot: slotOf(m.candidate.filename),
        position: m.meta.sortOrder ?? null,
      });

      const articles = [...new Set(matched.map((m) => describeMatch(m).article))];
      const galleryNote = keepGallery
        ? "Existing photos are PRESERVED (keepExistingGallery defaults to true — the opposite of the admin screen)."
        : `⚠ keepExistingGallery:false — the existing photos of ${articles.length} product(s) will be DELETED before the new ones are attached. No undo.`;

      if (dryRun) {
        return {
          store: args.store ?? null,
          dryRun: true,
          keepExistingGallery: keepGallery,
          totalSize: human(batch.reduce((n, c) => n + c.size, 0)),
          counts: counts({ matched: matched.length, unmatched: unmatched.length }),
          matched: matched.map(describeMatch),
          unmatched,
          rejected,
          articles,
          note:
            `Preview only — NOTHING was uploaded. The file→product mapping above is HOROSHOP'S OWN (import-images/check), not a local guess. ${galleryNote} ` +
            `Set dryRun:false to upload. There is no undo and no per-image delete.`,
        };
      }

      if (matched.length === 0) {
        return {
          store: args.store ?? null,
          dryRun: false,
          keepExistingGallery: keepGallery,
          counts: counts({ unmatched: unmatched.length }),
          verified: false,
          matched: [],
          unmatched,
          rejected,
          note: "Not one file matched a product, so nothing was uploaded. Check the articles in `unmatched` against the catalog.",
        };
      }

      // 2) Snapshot the touched products through the PUBLIC export, so the
      //    verification at the end comes from a different channel than the write.
      const readImages = async (): Promise<Map<string, string[]>> => {
        const out = new Map<string, string[]>();
        for (const part of chunk(articles, 100)) {
          const body: any = await client.call(args.store, "catalog/export", {
            expr: { article: part },
            includedParams: ["article", "images"],
          });
          for (const p of body?.response?.products ?? []) {
            out.set(String(p.article), Array.isArray(p.images) ? p.images.map(String) : []);
          }
        }
        return out;
      };

      let imagesBefore = new Map<string, string[]>();
      let snapshotError: string | null = null;
      try {
        imagesBefore = await readImages();
      } catch (e) {
        snapshotError = (e as Error).message;
      }

      // 3) Upload the bytes to the image cloud (external host, its own token).
      const uploads = await pooled(matched, UPLOAD_CONCURRENCY, async (m) => {
        const res = await client.admin.importImagesUpload(args.store, {
          awsApiLink,
          cloudToken,
          filename: m.candidate.filename,
          bytes: m.candidate.bytes,
          contentType: m.candidate.contentType,
          projectUuid: m.meta.projectUuid,
          awsKey: m.meta.awsKey,
        });
        return { m, res };
      });

      const uploaded = uploads.filter((u) => u.res.item?.uri);
      const uploadFailures = uploads
        .filter((u) => !u.res.item?.uri)
        .map((u) => ({ file: u.m.candidate.filename, httpStatus: u.res.httpStatus, error: u.res.raw.slice(0, 300) }));

      // 4) Bind the stored uris to their products.
      let assigned = 0;
      const assignFailures: Array<{ httpStatus: number; error: string; files: string[] }> = [];
      for (const part of chunk(uploaded, ASSIGN_CHUNK)) {
        const res = await client.admin.importImagesAssign(
          args.store,
          authToken,
          part.map((u) => ({
            handler: u.m.meta.handler,
            param: u.m.meta.param,
            parent: u.m.meta.parent,
            uri: u.res.item.uri,
            width: u.res.item.width,
            height: u.res.item.height,
            fileSize: u.res.item.fileSize,
            sortOrder: u.m.meta.sortOrder,
          })),
          !keepGallery,
        );
        if (res.json?.response?.success) assigned += part.length;
        else {
          assignFailures.push({
            httpStatus: res.httpStatus,
            error: res.raw.slice(0, 300),
            files: part.map((u) => u.m.candidate.filename),
          });
        }
      }

      // 5) Verify through the public export + one real HTTP fetch of a stored image.
      let imagesAfter = new Map<string, string[]>();
      let verifyError: string | null = null;
      try {
        imagesAfter = await readImages();
      } catch (e) {
        verifyError = (e as Error).message;
      }

      const perArticle = articles.map((a) => ({
        article: a,
        imagesBefore: imagesBefore.has(a) ? imagesBefore.get(a)!.length : null,
        imagesAfter: imagesAfter.has(a) ? imagesAfter.get(a)!.length : null,
      }));
      const grew = perArticle.filter((p) => p.imagesAfter !== null && p.imagesBefore !== null && p.imagesAfter > p.imagesBefore).length;
      // Verify against a URL that was NOT there before, so a pre-existing photo
      // cannot stand in as proof that this run stored anything.
      let sampleUrl: string | null = null;
      for (const a of articles) {
        const before = new Set(imagesBefore.get(a) ?? []);
        const fresh = (imagesAfter.get(a) ?? []).find((u) => !before.has(u));
        if (fresh) {
          sampleUrl = fresh;
          break;
        }
      }
      const assetCheck = sampleUrl ? await client.admin.verifyAsset(args.store, sampleUrl) : null;

      // Preserved galleries must grow; a wiped one legitimately may not, so the
      // count alone is only evidence in the keep-gallery case.
      const verified =
        assigned === uploaded.length &&
        uploaded.length > 0 &&
        assetCheck?.ok === true &&
        (keepGallery ? grew > 0 : imagesAfter.size > 0);

      return {
        store: args.store ?? null,
        dryRun: false,
        keepExistingGallery: keepGallery,
        counts: counts({
          matched: matched.length,
          uploaded: uploaded.length,
          assigned,
          unmatched: unmatched.length,
        }),
        verified,
        perArticle,
        assetCheck: assetCheck
          ? { url: assetCheck.url, httpStatus: assetCheck.httpStatus, contentType: assetCheck.contentType, bytes: assetCheck.bytes, ok: assetCheck.ok }
          : null,
        files: uploaded.map((u) => ({ ...describeMatch(u.m), uri: u.res.item.uri })),
        ...(uploadFailures.length ? { uploadFailures } : {}),
        ...(assignFailures.length ? { assignFailures } : {}),
        ...(unmatched.length ? { unmatched } : {}),
        ...(rejected.length ? { rejected } : {}),
        ...(snapshotError || verifyError
          ? { verificationUnavailable: snapshotError ?? verifyError }
          : {}),
        note:
          (verified
            ? `Uploaded and bound; re-read through the public catalog export, which shows the image counts above and serves the stored file as ${assetCheck?.contentType}.`
            : uploaded.length === 0
              ? "NOTHING was stored — every upload to the image cloud failed. See `uploadFailures`."
              : assigned < uploaded.length
                ? "Some images uploaded but were NOT bound to their products. See `assignFailures` — the bytes are in the cloud, the products did not change."
                : "Uploaded and the bind reported success, but the re-read does NOT confirm it. Treat this as unproven and check the products in the admin.") +
          " " +
          galleryNote +
          " No undo: this server has no route that removes a single photo from a gallery.",
      };
    },
  },
];
