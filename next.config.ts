import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Keep pdf.js out of the server bundle (used by `lib/extract-text.ts` for PDF
   * text extraction). Bundled, it resolves its worker relative to the emitted
   * chunk and fails at runtime with `Setting up fake worker failed: Cannot find
   * module .next/dev/server/chunks/pdf.worker.mjs`. Loaded via native `require`
   * from node_modules, the relative resolution works.
   */
  serverExternalPackages: ["pdfjs-dist"],
  experimental: {
    /**
     * Ceiling on the request body Next buffers when a proxy is present (this app
     * has `proxy.ts` for Clerk). The default is 10 MB, which would *truncate*
     * rather than reject a larger document upload — surfacing to the user as a
     * corrupt-file error instead of a size error.
     *
     * Kept slightly above `MAX_UPLOAD_BYTES` (25 MB, `config/attachments.ts`) so
     * an oversized upload trips our own size check and gets a clear message.
     * Raise both together or neither.
     */
    proxyClientMaxBodySize: "30mb",
  },
};

export default nextConfig;
