import { stat } from "node:fs/promises";

/**
 * Human-readable file size. Scales the unit by magnitude (B / KB / MB / GB)
 * so a 1.2 GB output is not reported as "1258291.2 KB".
 */
export async function getFileSize(filePath: string): Promise<string> {
  const stats = await stat(filePath);
  return formatBytes(stats.size);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes / 1024;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(1)} ${units[unitIndex]}`;
}
