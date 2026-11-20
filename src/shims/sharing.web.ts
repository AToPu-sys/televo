// Web stand-in for expo-sharing: there is no share sheet in a browser, so
// "share" downloads the file under the name the sender gave it.

export async function isAvailableAsync(): Promise<boolean> {
  return typeof document !== "undefined";
}

export async function shareAsync(url: string, options?: { dialogTitle?: string; mimeType?: string }): Promise<void> {
  const a = document.createElement("a");
  a.href = url;
  a.download = (options?.dialogTitle || "download").replace(/[\\/:*?"<>|]/g, "_");
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
