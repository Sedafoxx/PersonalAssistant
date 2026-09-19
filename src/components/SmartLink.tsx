"use client";

import { useEffect, useState, type ReactNode } from "react";
import { appHref } from "@/lib/app-links";

/**
 * An anchor that hands a YouTube or Spotify link to its own app on Android.
 *
 * The rewrite happens AFTER mount on purpose. The href depends on the user agent,
 * which does not exist on the server, so resolving it during render would produce
 * a different href on the server than on the client and React would flag a
 * hydration mismatch. Before mount the plain URL is rendered — always valid, and
 * swapped long before anyone can tap it.
 *
 * `target="_blank"` is dropped for an `intent://` href: those are handled by the
 * system, not by opening a tab, and a blank target can make some Android browsers
 * swallow the handoff instead of launching the app.
 */
export function SmartLink({
  href,
  className,
  children,
  title,
}: {
  href: string;
  className?: string;
  children: ReactNode;
  title?: string;
}) {
  const [resolved, setResolved] = useState(href);

  useEffect(() => {
    setResolved(appHref(href));
  }, [href]);

  const isIntent = resolved.startsWith("intent://");

  return (
    <a
      href={resolved}
      title={title}
      target={isIntent ? undefined : "_blank"}
      rel={isIntent ? undefined : "noopener noreferrer"}
      className={className}
    >
      {children}
    </a>
  );
}
