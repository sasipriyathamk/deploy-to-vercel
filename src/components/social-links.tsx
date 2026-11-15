import type { ReactNode } from "react";
import { Globe } from "lucide-react";
import type { TokenSocials } from "@/lib/logic/quality";

function Mark({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden="true">
      {children}
    </svg>
  );
}

export function SocialLinks({ links }: { links: TokenSocials | null | undefined }) {
  if (!links) return null;
  const items: { href: string; label: string; icon: ReactNode }[] = [];
  if (links.twitter) {
    items.push({
      href: links.twitter,
      label: "X",
      icon: (
        <Mark>
          <path
            fill="currentColor"
            d="M9.3 7.1 13.6 2h-1.2L8.8 6.4 5.9 2H2.1l4.5 6.5L2.2 14h1.2l3.7-4.4L10.5 14h3.7L9.3 7.1Zm-1.3 1.5-.4-.6L4 3.1h1.4l2.6 3.8.4.6 3.6 5.3h-1.4L8 8.6Z"
          />
        </Mark>
      ),
    });
  }
  if (links.telegram) {
    items.push({
      href: links.telegram,
      label: "Telegram",
      icon: (
        <Mark>
          <path
            fill="currentColor"
            d="M14.4 2.7 1.7 7.6c-.8.3-.8.8-.1 1l3.2 1 .1 3.2c0 .4.2.5.5.5.2 0 .4-.1.5-.3l1.6-1.5 3.3 2.4c.6.3 1 .2 1.2-.6l2.2-10c.2-.8-.3-1.2-1.2-.8ZM6.3 9.4l6.3-4c.3-.2.6 0 .3.2l-5.2 4.7-.2 2.2-1.2-3.1Z"
          />
        </Mark>
      ),
    });
  }
  if (links.website) {
    items.push({ href: links.website, label: "Website", icon: <Globe className="size-3.5" aria-hidden="true" /> });
  }

  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {items.map((item) => (
        <a
          key={item.label}
          href={item.href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={item.label}
          title={item.label}
          className="inline-flex size-8 items-center justify-center rounded-lg border border-white/[0.08] bg-paper text-muted hover:border-emerald-500/40 hover:text-emerald-400 hover:bg-surface-hover transition-all active:scale-95"
          onClick={(event) => event.stopPropagation()}
        >
          {item.icon}
        </a>
      ))}
    </div>
  );
}
