// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import { chmodSync, renameSync, statfsSync, writeFileSync } from "node:fs";

/**
 * Writes via a temporary file and a rename, which is atomic on local filesystems and on NFS,
 * so a reader (possibly on another host sharing the directory) never sees a torn file.
 * No file locks are used anywhere: they are unreliable on NFS.
 */
export function writeFileAtomic(path: string, data: string, mode = 0o600): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, data, { mode });
  chmodSync(temp, mode);
  renameSync(temp, path);
}

// statfs f_type magic numbers of network and cluster filesystems (Linux).
const NETWORK_FILESYSTEMS: Record<number, string> = {
  0x6969: "NFS",
  0xff534d42: "SMB",
  0xfe534d42: "SMB",
  0x517b: "SMB",
  0x0bd00bd0: "Lustre",
  0x47504653: "GPFS",
  0x00c36400: "CephFS",
  0x5346414f: "AFS",
  0x01021997: "9p",
};

/** The name of the network filesystem `dir` is on, or null for a local one (or if unknown). */
export function networkFilesystem(dir: string): string | null {
  if (process.platform !== "linux") return null;
  try {
    return NETWORK_FILESYSTEMS[statfsSync(dir).type] ?? null;
  } catch {
    return null;
  }
}
