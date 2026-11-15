"use client";

import { useState } from "react";
import { gmgnTokenUrl } from "@/lib/logic/metadata";

export function TokenLogo({ src, size = "sm" }: { src: string | null; size?: "sm" | "md" }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const dim = size === "md" ? "size-10" : "size-7";
  const px = size === "md" ? 40 : 28;
  if (!src || failedSrc === src) {
    return <span aria-hidden className={`${dim} shrink-0 rounded-full border border-line bg-chip`} />;
  }
  return (
    // Logos arrive from many token CDNs. next/image would need a fixed host allowlist.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      width={px}
      height={px}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      className={`${dim} shrink-0 rounded-full border border-line bg-chip object-cover`}
      onError={() => setFailedSrc(src)}
    />
  );
}

export function GmgnLink({ mint }: { mint: string }) {
  return (
    <a
      href={gmgnTokenUrl(mint)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Open on GMGN"
      title="Open on GMGN"
      className="inline-flex size-10 shrink-0 items-center justify-center rounded-full hover:bg-chip focus-visible:ring-2 focus-visible:ring-teal/70"
      onClick={(event) => event.stopPropagation()}
    >
      {/* Local brand asset. next/image does not optimize this svg. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/gmgn.svg" alt="" width={20} height={20} className="size-5 [image-rendering:pixelated]" />
    </a>
  );
}
