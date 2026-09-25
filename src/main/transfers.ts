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
 * device. installApk always replaces an existing install (the M5 plan's
 * fixed policy, not a per-transfer option).
 */
export interface TransferDeps {
  openFile(localPath: string): Promise<LocalFile>;
  installApk(stream: ReadableStream<Uint8Array>): Promise<void>;
  pushFile(devicePath: string, stream: ReadableStream<Uint8Array>): Promise<void>;
  scanFile(devicePath: string): Promise<void>;
}

export interface TransferQueue {
  /** Runs one at a time, in the order given; a file already queued or running from an earlier call is not disturbed. */
  enqueue(localPaths: string[]): void;
  /** Cancels the running transfer and drops everything still queued; the queue never starts new work after this (a device switch ends its lifetime). */
  cancelAll(): void;
  onProgress(fn: (p: TransferProgress) => void): () => void;
}

const DOWNLOAD_DIR = "/sdcard/Download";

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
    const counted = file.stream.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytesWritten += chunk.byteLength;
          emit(item, "running", bytesWritten, file.size);
          controller.enqueue(chunk);
        },
      }),
    );

    try {
      if (item.kind === "install") {
        await deps.installApk(counted);
      } else {
        const devicePath = `${DOWNLOAD_DIR}/${item.name}`;
        await deps.pushFile(devicePath, counted);
        await deps.scanFile(devicePath);
      }
      emit(item, cancelled || abort.signal.aborted ? "cancelled" : "done", bytesWritten, file.size);
    } catch (e) {
      if (cancelled || abort.signal.aborted) {
        emit(item, "cancelled", bytesWritten, file.size);
      } else {
        log?.(`transfer failed: ${item.name}: ${String(e)}`);
        emit(item, "error", bytesWritten, file.size, String(e));
      }
    } finally {
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
