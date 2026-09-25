import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import type { TransferKind, TransferProgress, TransferState } from "../shared/wire";

export type { TransferKind, TransferProgress, TransferState };

export interface LocalFile {
  size: number;
  stream: ReadableStream<Uint8Array>;
}

/** The real, disk-reading implementation of TransferDeps' openFile; swapped for a fake in tests. */
export async function defaultOpenFile(localPath: string): Promise<LocalFile> {
  const info = await stat(localPath);
  return { size: info.size, stream: Readable.toWeb(createReadStream(localPath)) as ReadableStream<Uint8Array> };
}

/**
 * The real Tango/Node calls, isolated so a fake adb and fake filesystem can
 * drive the queue, ordering and cancellation logic in tests without a
 * device. installApk always replaces an existing install (a fixed policy,
 * not a per-transfer option).
 */
export interface TransferDeps {
  openFile(localPath: string): Promise<LocalFile>;
  installApk(stream: ReadableStream<Uint8Array>): Promise<void>;
  pushFile(devicePath: string, stream: ReadableStream<Uint8Array>): Promise<void>;
  scanFile(devicePath: string): Promise<void>;
  /** Best-effort cleanup of a partially-written push left behind by a cancellation; failures are swallowed by the caller. */
  removeFile(devicePath: string): Promise<void>;
}

export interface TransferQueue {
  /** Runs one at a time, in the order given; a file already queued or running from an earlier call is not disturbed. */
  enqueue(localPaths: string[]): void;
  /** Cancels the running transfer and drops everything still queued; the queue never starts new work after this (a device switch ends its lifetime). */
  cancelAll(): void;
  onProgress(fn: (p: TransferProgress) => void): () => void;
}

const DOWNLOAD_DIR = "/sdcard/Download";
/** At most 10 "running" progress messages per second per transfer; done/error/cancelled are never throttled. */
const PROGRESS_THROTTLE_MS = 100;

function baseName(localPath: string): string {
  const parts = localPath.split(/[\\/]/);
  return parts[parts.length - 1] || localPath;
}

function isApk(name: string): boolean {
  return name.toLowerCase().endsWith(".apk");
}

interface QueuedItem {
  id: string;
  localPath: string;
  name: string;
  kind: TransferKind;
}

export function createTransferQueue(deps: TransferDeps, log?: (line: string) => void): TransferQueue {
  const listeners = new Set<(p: TransferProgress) => void>();
  const queue: QueuedItem[] = [];
  let running = false;
  let cancelled = false;
  let currentAbort: AbortController | null = null;
  let nextId = 0;

  function emit(item: QueuedItem, state: TransferState, bytesWritten: number, totalBytes: number, message?: string): void {
    const progress: TransferProgress = { id: item.id, name: item.name, kind: item.kind, state, bytesWritten, totalBytes, message };
    for (const fn of listeners) fn(progress);
  }

  async function runNext(): Promise<void> {
    if (running || cancelled) return;
    const item = queue.shift();
    if (!item) return;
    running = true;
    const abort = new AbortController();
    currentAbort = abort;
    const devicePath = item.kind === "push" ? `${DOWNLOAD_DIR}/${item.name}` : null;

    let file: LocalFile;
    try {
      file = await deps.openFile(item.localPath);
    } catch (e) {
      emit(item, "error", 0, 0, String(e));
      running = false;
      currentAbort = null;
      void runNext();
      return;
    }

    if (cancelled) {
      emit(item, "cancelled", 0, file.size);
      running = false;
      currentAbort = null;
      return;
    }

    emit(item, "running", 0, file.size);
    let bytesWritten = 0;
    let lastEmitAt = 0;
    let transformController: TransformStreamDefaultController<Uint8Array> | undefined;
    const counted = file.stream.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        start(controller) {
          transformController = controller;
        },
        transform(chunk, controller) {
          bytesWritten += chunk.byteLength;
          const now = Date.now();
          if (now - lastEmitAt >= PROGRESS_THROTTLE_MS) {
            lastEmitAt = now;
            emit(item, "running", bytesWritten, file.size);
          }
          controller.enqueue(chunk);
        },
      }),
    );
    // Tango's write/install calls read `counted` internally; erroring the
    // transform's controller on abort is what makes the in-flight
    // adb.sync.write/pushAndInstallStream call actually stop and reject,
    // instead of running to completion after cancelAll() merely relabels it.
    const onAbort = () => {
      try {
        transformController?.error(new Error("transfer cancelled"));
      } catch {
        // already closed or errored
      }
    };
    abort.signal.addEventListener("abort", onAbort, { once: true });

    try {
      if (item.kind === "install") {
        await deps.installApk(counted);
      } else {
        await deps.pushFile(devicePath!, counted);
        await deps.scanFile(devicePath!);
      }
      emit(item, cancelled || abort.signal.aborted ? "cancelled" : "done", bytesWritten, file.size);
    } catch (e) {
      if (cancelled || abort.signal.aborted) {
        if (devicePath) await deps.removeFile(devicePath).catch(() => {});
        emit(item, "cancelled", bytesWritten, file.size);
      } else {
        log?.(`transfer failed: ${item.name}: ${String(e)}`);
        emit(item, "error", bytesWritten, file.size, String(e));
      }
    } finally {
      abort.signal.removeEventListener("abort", onAbort);
      running = false;
      currentAbort = null;
      void runNext();
    }
  }

  return {
    enqueue(localPaths) {
      if (cancelled) return;
      for (const localPath of localPaths) {
        nextId += 1;
        const name = baseName(localPath);
        const item: QueuedItem = { id: `t${nextId}`, localPath, name, kind: isApk(name) ? "install" : "push" };
        queue.push(item);
        emit(item, "queued", 0, 0);
      }
      void runNext();
    },
    cancelAll() {
      if (cancelled) return;
      cancelled = true;
      currentAbort?.abort();
      for (const item of queue.splice(0, queue.length)) emit(item, "cancelled", 0, 0);
    },
    onProgress(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
