import { stat } from "node:fs/promises";

export async function getFileSize(filePath: string): Promise<string> {
  const stats = await stat(filePath);
  return `${(stats.size / 1024).toFixed(1)} KB`;
}
