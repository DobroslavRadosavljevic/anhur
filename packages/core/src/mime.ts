const TYPES = new Map<string, string>([
  [".avif", "image/avif"],
  [".bmp", "image/bmp"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".tif", "image/tiff"],
  [".tiff", "image/tiff"],
  [".webp", "image/webp"],
  [".aac", "audio/aac"],
  [".flac", "audio/flac"],
  [".m4a", "audio/mp4"],
  [".mp3", "audio/mpeg"],
  [".oga", "audio/ogg"],
  [".ogg", "audio/ogg"],
  [".opus", "audio/opus"],
  [".wav", "audio/wav"],
  [".weba", "audio/webm"],
  [".m4v", "video/mp4"],
  [".mov", "video/quicktime"],
  [".mp4", "video/mp4"],
  [".ogv", "video/ogg"],
  [".webm", "video/webm"],
  [".vtt", "text/vtt; charset=utf-8"],
  [".otf", "font/otf"],
  [".ttf", "font/ttf"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".csv", "text/csv; charset=utf-8"],
  [".json", "application/json"],
  [".md", "text/markdown; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".htm", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".cjs", "text/javascript; charset=utf-8"],
  [".pdf", "application/pdf"],
  [".txt", "text/plain; charset=utf-8"],
  [".xml", "application/xml"],
  [".zip", "application/zip"],
  [".gz", "application/gzip"],
  [".wasm", "application/wasm"],
  [".epub", "application/epub+zip"],
  [".doc", "application/msword"],
  [
    ".docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  [".xls", "application/vnd.ms-excel"],
  [
    ".xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
  [".ppt", "application/vnd.ms-powerpoint"],
  [
    ".pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
]);

/** Content type for a file extension (`.svg` → `image/svg+xml`). */
export function contentTypeForExtension(extension: string): string {
  return TYPES.get(extension.toLowerCase()) ?? "application/octet-stream";
}

/** Content type for a file path, by extension. */
export function contentTypeForPath(filePath: string): string {
  const match = /\.[^./\\]+$/.exec(filePath);
  return contentTypeForExtension(match ? match[0] : "");
}
